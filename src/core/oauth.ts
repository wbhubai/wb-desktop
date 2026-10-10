/**
 * Port of wbs `modules/oauth.rs` — device-style OAuth flow: state creation,
 * token polling, account fetch, domain-consistency gate. All requests follow
 * the INITIATING variant; poll must reuse the variant stored at start.
 */
import { buildAuthHeaders, getStr, isEnvelope, upsertCollectedAccount, type WbAccount } from './account.ts'
import { isPlainObject, nowMs, nowSecs } from './util.ts'
import {
  variantApiEndpoint,
  variantApiPrefix,
  variantMatchesDomain,
  variantOauthPlatform,
  type WbVariant,
} from './variant.ts'
import type { HttpEnvelope, HttpFetcher } from './util.ts'
import { fetchHttp } from './util.ts'

export interface OAuthDeps {
  http?: HttpFetcher
  now?: () => number
}

export interface OAuthStartResult {
  loginId: string
  verificationUri: string
  expiresIn: number
}

export interface OAuthPollResult {
  done: boolean
  result?: Record<string, unknown>
  error?: string
}

interface OAuthInfo {
  variant: WbVariant
  state: string
  expiresAt: number // secs
  done: boolean
  result?: Record<string, unknown>
  error?: string
}

export const OAUTH_TIMEOUT_SECS = 600

export const DOMAIN_MISMATCH_PREFIX = '登录响应的 domain'

export function domainMismatchError(variant: WbVariant, domain: string): string {
  const label = variant === 'ai' ? '国际版' : '国内版'
  return `登录响应的 domain（${domain}）与${label}档位不符，已拒绝入库`
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function dataOf(response: HttpEnvelope): Record<string, unknown> {
  const data = (response as Record<string, unknown>)['data']
  return isPlainObject(data) ? data : {}
}

function codeOf(response: HttpEnvelope): number | null {
  const code = (response as Record<string, unknown>)['code']
  if (typeof code === 'number' && Number.isFinite(code)) return code
  if (typeof code === 'string' && code.trim() !== '' && Number.isFinite(Number(code))) return Number(code)
  return null
}

/** Profile email: only real non-empty trimmed email strings — never nickname/uid. */
export function oauthProfileEmail(profile: Record<string, unknown>): string | undefined {
  const email = getStr(profile, 'email')
  return email && email.includes('@') ? email : undefined
}

export function buildAccountFromOauth(input: {
  tokenData: Record<string, unknown>
  profileData: Record<string, unknown>
  tokenDomain: string
  variant: WbVariant
  accessToken: string
  now?: number
}): WbAccount {
  const now = input.now ?? nowMs()
  const tokenData = input.tokenData
  const profile = input.profileData
  const expiresAt =
    normTsField(tokenData, 'expiresAt', 'expires_at') ?? fromExpiresIn(tokenData, 'expiresIn', 'expires_in', now)
  const refreshExpiresAt =
    normTsField(tokenData, 'refreshExpiresAt', 'refresh_expires_at') ??
    fromExpiresIn(tokenData, 'refreshExpiresIn', 'refresh_expires_in', now)
  const account: WbAccount = {
    id: crypto.randomUUID(),
    uid: getStr(profile, 'uid') ?? null,
    nickname: getStr(profile, 'nickname') ?? null,
    email: oauthProfileEmail(profile) ?? null,
    enterpriseName: getStr(profile, 'enterpriseName') ?? null,
    enterpriseId: getStr(profile, 'enterpriseId') ?? null,
    access_token: input.accessToken,
    refresh_token: str(tokenData['refreshToken'] ?? tokenData['refresh_token']) || null,
    token_type: str(tokenData['tokenType'] ?? tokenData['token_type']) || 'Bearer',
    domain: input.tokenDomain,
    variant: input.variant,
    expiresAt: expiresAt ?? null,
    refreshExpiresAt: refreshExpiresAt ?? null,
    auth_raw: tokenData,
    profile_raw: profile,
    createdAt: now,
  }
  return account
}

function normTsField(record: Record<string, unknown>, camel: string, snake: string): number | null {
  for (const key of [camel, snake]) {
    const value = record[key]
    if (value !== undefined && value !== null) {
      const numeric =
        typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
      if (Number.isFinite(numeric)) return Math.abs(Math.trunc(numeric)) < 10_000_000_000 ? Math.trunc(numeric) * 1000 : Math.trunc(numeric)
    }
  }
  return null
}

function fromExpiresIn(record: Record<string, unknown>, camel: string, snake: string, now: number): number | null {
  for (const key of [camel, snake]) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return now + value * 1000
  }
  return null
}

/** Own-state store (mirrors the Rust in-memory OAUTH_STATES map). */
export class OAuthFlow {
  private readonly states = new Map<string, OAuthInfo>()
  private readonly http: HttpFetcher
  private readonly now: () => number
  private readonly saveAccount: (collected: WbAccount) => Promise<Record<string, unknown>>

  constructor(saveAccount: (collected: WbAccount) => Promise<Record<string, unknown>>, deps: OAuthDeps = {}) {
    this.http = deps.http ?? fetchHttp
    this.now = deps.now ?? nowSecs
    this.saveAccount = saveAccount
  }

  oauthUrls(variant: WbVariant) {
    const endpoint = variantApiEndpoint(variant)
    const prefix = variantApiPrefix(variant)
    const platform = variantOauthPlatform(variant)
    return {
      state: `${endpoint}${prefix}/auth/state?platform=${platform}`,
      token: `${endpoint}${prefix}/auth/token`,
      account: `${endpoint}${prefix}/login/account`,
    }
  }

  async oauthStart(variant: WbVariant): Promise<OAuthStartResult> {
    const loginId = `wb_${crypto.randomUUID().replace(/-/g, '')}`
    const urls = this.oauthUrls(variant)
    const response = await this.http(urls.state, 'POST', {})
    const data = dataOf(response)
    const state = str(data['state'])
    if (!state) {
      throw new Error(`auth/state 响应缺少 state: ${JSON.stringify(response).slice(0, 300)}`)
    }
    const authUrl =
      str(data['authUrl']) || str(data['auth_url']) || str(data['url']) || `${variantApiEndpoint(variant)}/login?state=${state}`
    this.states.set(loginId, { variant, state, expiresAt: this.now() + OAUTH_TIMEOUT_SECS, done: false })
    return { loginId, verificationUri: authUrl, expiresIn: OAUTH_TIMEOUT_SECS }
  }

  async oauthPoll(loginId: string): Promise<OAuthPollResult> {
    const info = this.states.get(loginId)
    if (!info) return { done: true, error: '登录请求不存在' }
    if (info.done) return { done: true, result: info.result, error: info.error }
    if (this.now() > info.expiresAt) {
      info.done = true
      info.error = '登录超时'
      return { done: true, error: info.error }
    }
    const urls = this.oauthUrls(info.variant)
    const tokenResponse = await this.http(`${urls.token}?state=${encodeURIComponent(info.state)}`, 'GET')
    const code = codeOf(tokenResponse)
    if (code !== 0 && code !== 200) return { done: false }
    const tokenData = dataOf(tokenResponse)
    const accessToken = str(tokenData['accessToken'] ?? tokenData['access_token'])
    if (!accessToken) return { done: false }
    const domain = str(tokenData['domain'])
    if (!variantMatchesDomain(info.variant, domain)) {
      info.done = true
      info.error = domainMismatchError(info.variant, domain)
      return { done: true, error: info.error }
    }
    const accountHeaders: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      ...buildAuthHeaders({ access_token: accessToken, domain: domain || undefined }),
    }
    if (domain) accountHeaders['X-Domain'] = domain
    const accountResponse = await this.http(`${urls.account}?state=${encodeURIComponent(info.state)}`, 'GET', undefined, accountHeaders)
    if (!variantMatchesDomain(info.variant, str(dataOf(accountResponse)['domain']))) {
      const mismatch = domainMismatchError(info.variant, str(dataOf(accountResponse)['domain']))
      return this.failOauth(loginId, mismatch)
    }
    const account = buildAccountFromOauth({
      tokenData,
      profileData: dataOf(accountResponse),
      tokenDomain: domain,
      variant: info.variant,
      accessToken,
    })
    try {
      const saved = await this.saveAccount(account)
      info.done = true
      info.result = saved
      return { done: true, result: saved }
    } catch (error) {
      return this.failOauth(loginId, `保存账号失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  failOauth(loginId: string, error: string): OAuthPollResult {
    const info = this.states.get(loginId)
    if (info) {
      info.done = true
      info.error = error
    }
    return { done: true, error }
  }
}

// re-exports for callers
export { isEnvelope, upsertCollectedAccount }
