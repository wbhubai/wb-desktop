/**
 * Port of wbs `modules/refresh.rs` — token refresh with the mandatory
 * `X-Refresh-Token` / `X-Auth-Refresh-Source: plugin` headers, needs_relogin
 * marking on failure (retry-stop), lazy refresh and the daily keepalive cycle.
 */
import { buildAuthHeaders, getStr, upsertAccountIn, variantOf, type WbAccount } from './account.ts'
import { isPlainObject, nowMs } from './util.ts'
import type { HttpEnvelope, HttpFetcher } from './util.ts'
import { fetchHttp } from './util.ts'
import { variantApiEndpoint, variantApiPrefix, type WbVariant } from './variant.ts'

export interface RefreshDeps {
  http?: HttpFetcher
  now?: () => number
}

export interface RefreshResult {
  account: WbAccount
  ok: boolean
  error?: string
}

/** Pure and testable: auth headers + X-Refresh-Token + X-Auth-Refresh-Source. */
export function refreshHeaders(account: WbAccount, refreshToken: string): Record<string, string> {
  return {
    ...buildAuthHeaders(account),
    'X-Refresh-Token': refreshToken,
    'X-Auth-Refresh-Source': 'plugin',
  }
}

export function refreshUrl(variant: WbVariant): string {
  return `${variantApiEndpoint(variant)}${variantApiPrefix(variant)}/auth/token/refresh`
}

function normTsValue(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = Math.trunc(value)
    return Math.abs(ms) < 10_000_000_000 ? ms * 1000 : ms
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      const ms = Math.trunc(parsed)
      return Math.abs(ms) < 10_000_000_000 ? ms * 1000 : ms
    }
  }
  return null
}

function str(response: Record<string, unknown>, key: string): string {
  const value = response[key]
  return typeof value === 'string' ? value : ''
}

function codeOf(response: HttpEnvelope): number | null {
  const code = (response as Record<string, unknown>)['code']
  if (typeof code === 'number' && Number.isFinite(code)) return code
  if (typeof code === 'string' && code.trim() !== '' && Number.isFinite(Number(code))) return Number(code)
  return null
}

function dataOf(response: HttpEnvelope): Record<string, unknown> {
  const data = (response as Record<string, unknown>)['data']
  return isPlainObject(data) ? data : {}
}

/**
 * Refresh one account. Every failure path writes needs_relogin/reason into the
 * account and returns it (the flag itself is the retry-stop); success clears
 * the flags and bumps refreshedAt.
 */
export async function refreshAccountToken(
  account: WbAccount,
  upsert: (updated: WbAccount) => void,
  deps: RefreshDeps = {},
): Promise<RefreshResult> {
  const http = deps.http ?? fetchHttp
  const now = deps.now ?? nowMs
  const variant = variantOf(account)
  const updated: WbAccount = { ...account }
  const refreshToken = getStr(updated, 'refresh_token')
  if (!refreshToken) {
    updated['needs_relogin'] = true
    updated['needs_relogin_reason'] = '缺少 refresh token，无法刷新，需重新登录'
    upsert(updated)
    return { account: updated, ok: false, error: updated['needs_relogin_reason'] as string }
  }
  const response = await http(refreshUrl(variant), 'POST', {}, refreshHeaders(updated, refreshToken))
  const code = codeOf(response)
  if (code !== 0 && code !== 200) {
    const message = str(response, 'message') || str(response, 'msg') || '未知错误'
    updated['needs_relogin'] = true
    updated['needs_relogin_reason'] = `刷新失败(code=${code ?? '空'}): ${message}`
    upsert(updated)
    return { account: updated, ok: false, error: updated['needs_relogin_reason'] as string }
  }
  const data = dataOf(response)
  const accessToken = str(data, 'accessToken') || str(data, 'access_token')
  if (!accessToken) {
    updated['needs_relogin'] = true
    updated['needs_relogin_reason'] = '刷新响应缺少 accessToken'
    upsert(updated)
    return { account: updated, ok: false, error: updated['needs_relogin_reason'] as string }
  }
  updated['access_token'] = accessToken
  const newRefresh = str(data, 'refreshToken') || str(data, 'refresh_token')
  if (newRefresh) updated['refresh_token'] = newRefresh
  const expiresAt =
    normTsValue(data['expiresAt']) ??
    normTsValue(data['expires_at']) ??
    (Number.isFinite(Number(data['expiresIn']))
      ? now() + Number(data['expiresIn']) * 1000
      : Number.isFinite(Number(data['expires_in']))
        ? now() + Number(data['expires_in']) * 1000
        : null)
  if (expiresAt !== null) updated['expiresAt'] = expiresAt
  const authRaw = isPlainObject(updated['auth_raw']) ? updated['auth_raw'] : {}
  const refreshExpiresAt =
    normTsValue(data['refreshExpiresAt']) ??
    normTsValue(data['refresh_expires_at']) ??
    normTsValue(authRaw['refreshExpiresAt']) ??
    (Number.isFinite(Number(data['refreshExpiresIn']))
      ? now() + Number(data['refreshExpiresIn']) * 1000
      : Number.isFinite(Number(data['refresh_expires_in']))
        ? now() + Number(data['refresh_expires_in']) * 1000
        : null)
  if (refreshExpiresAt !== null) updated['refreshExpiresAt'] = refreshExpiresAt
  updated['refreshedAt'] = now()
  delete updated['needs_relogin']
  delete updated['needs_relogin_reason']
  upsert(updated)
  return { account: updated, ok: true }
}

/** Stale = missing expiry, expired, or remaining < lazyRefreshHours. */
export function isTokenStale(account: WbAccount, lazyRefreshHours: number, at = nowMs()): boolean {
  const expiresAt = normTsValue(account['expiresAt'])
  if (expiresAt === null) return true
  return at >= expiresAt || expiresAt - at < lazyRefreshHours * 3_600_000
}

export async function ensureFreshToken(
  account: WbAccount,
  upsert: (updated: WbAccount) => void,
  lazyRefreshHours = 24,
  deps: RefreshDeps = {},
): Promise<WbAccount> {
  if (!isTokenStale(account, lazyRefreshHours)) return account
  if (!getStr(account, 'refresh_token')) return account
  const result = await refreshAccountToken(account, upsert, deps)
  return result.account
}

export interface KeepaliveRow {
  email: string
  status: 'ok' | 'failed' | 'missing_rt'
  error?: string
}

/**
 * Daily keepalive: `keepaliveDays <= 0` refreshes unconditionally (avoids
 * server pruning idle refresh sessions, historically causing 12153); otherwise
 * only accounts within the window. Missing refresh token → needs_relogin.
 */
export async function runKeepaliveCycle(
  accounts: WbAccount[],
  config: { keepaliveDays?: number },
  upsert: (updated: WbAccount) => void,
  deps: RefreshDeps = {},
): Promise<{ checked: number; refreshed: KeepaliveRow[] }> {
  const keepDays = config.keepaliveDays ?? 0
  const at = (deps.now ?? nowMs)()
  const refreshed: KeepaliveRow[] = []
  for (const account of accounts) {
    const email = getStr(account, 'email') ?? accountDisplayNameOf(account)
    const expiresAt = normTsValue(account['expiresAt'])
    const stale = keepDays <= 0 || expiresAt === null || expiresAt - at < keepDays * 86_400_000
    if (!stale) continue
    if (!getStr(account, 'refresh_token')) {
      const updated: WbAccount = {
        ...account,
        needs_relogin: true,
        needs_relogin_reason: '缺少 refresh token，无法保活，需重新登录',
      }
      upsert(updated)
      refreshed.push({ email, status: 'missing_rt' })
      continue
    }
    const result = await refreshAccountToken(account, upsert, deps)
    refreshed.push(
      result.ok
        ? { email, status: 'ok' }
        : { email, status: 'failed', error: getStr(result.account, 'needs_relogin_reason') ?? '刷新失败' },
    )
  }
  return { checked: accounts.length, refreshed }
}

function accountDisplayNameOf(account: WbAccount): string {
  return getStr(account, 'nickname') ?? getStr(account, 'uid') ?? 'unknown'
}
