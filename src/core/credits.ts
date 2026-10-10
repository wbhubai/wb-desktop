/**
 * Port of wbs `modules/credits.rs` — credit/points balance + expiry query:
 * response parsing, nested extraction, expiry resolution (placeholder
 * DeductionEndTime override), urgency aggregation. HTTP injected.
 */
import { envelopeTokenError, getStr, type WbAccount } from './account.ts'
import { isPlainObject, normTs, responseCode, truncate } from './util.ts'
import { variantOf } from './account.ts'
import {
  codebuddyDomainFor,
  supportsCheckin,
  variantApiEndpoint,
  variantBillingPaths,
  type WbVariant,
} from './variant.ts'

export const EXPIRING_SOON_DAYS = 7
export const EXPIRY_CYCLE_OVERRIDE_MS = 365 * 86_400_000
export const FAR_FUTURE_EXPIRY_MS = 730 * 86_400_000
export const AI_API_ENDPOINT = 'https://www.workbuddy.ai'
export const WORKBUDDY_WEB_ENDPOINT = 'https://www.workbuddy.cn'
export const PRODUCT_CODE = 'p_tcaca'

// ------------------------------------------------------------- time parsing

export function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const rounded = Math.round(value)
    return Math.abs(rounded) < 10_000_000_000 ? rounded * 1000 : rounded
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '') return null
  // numeric string
  if (/^-?\d+(\.\d+)?$/.test(text)) return parseTimestampMs(Number(text))
  // RFC3339
  const iso = Date.parse(text)
  if (!Number.isNaN(iso) && /t|\//i.test(text) === /t/i.test(text) && text.includes('-')) {
    if (text.includes('T') || text.includes('Z') || /[+-]\d{2}:?\d{2}$/.test(text)) return iso
  }
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?)?$/.exec(text)
  if (dateMatch) {
    const [, y, m, d, hh = '00', mm = '00', ss = '00'] = dateMatch
    const hasTime = dateMatch[4] !== undefined
    const date = new Date(Number(y), Number(m) - 1, Number(d), hasTime ? Number(hh) : 23, hasTime ? Number(mm) : 59, hasTime ? Number(ss) : 59)
    return date.getTime()
  }
  return null
}

export function resolveExpireAt(raw: Record<string, unknown>, now: number): number | null {
  const first = (...keys: string[]): number | null => {
    for (const key of keys) {
      const parsed = parseTimestampMs(raw[key])
      if (parsed !== null) return parsed
    }
    return null
  }
  const deductionEnd = first('DeductionEndTime', 'deductionEndTime', 'ExpiredTime', 'expiredTime')
  const cycleEnd = first('CycleEndTime', 'cycleEndTime')
  let expireAt: number | null
  if (deductionEnd !== null && cycleEnd !== null && deductionEnd - cycleEnd > EXPIRY_CYCLE_OVERRIDE_MS) {
    expireAt = cycleEnd // 2049-style placeholder
  } else if (deductionEnd !== null) {
    expireAt = deductionEnd
  } else {
    expireAt = cycleEnd
  }
  if (expireAt === null) return null
  return expireAt - now <= FAR_FUTURE_EXPIRY_MS ? expireAt : null
}

// ------------------------------------------------------------ response判定

export function isSuccess(response: unknown): boolean {
  if (!isPlainObject(response)) return false
  const code = responseCode(response)
  if (code !== null) return code === 0 || code === 200
  if (!('data' in response)) return false
  return response['ok'] !== false && response['success'] !== false
}

export function responseError(response: unknown): string {
  if (isPlainObject(response)) {
    const data = isPlainObject(response['data']) ? response['data'] : {}
    for (const value of [response['message'], response['msg'], data['message'], data['msg']]) {
      if (typeof value === 'string' && value.trim() !== '') return truncate(value, 160)
    }
  }
  const code = responseCode(response)
  return `积分查询失败（code=${code ?? '空'}）`
}

export function isUnauthorized(response: unknown): boolean {
  const code = responseCode(response)
  if (code === 401 || code === 403) return true
  if (code === 10085) return false // gateway WAF fingerprint, NOT token expiry
  if (isSuccess(response)) return false
  if (!isPlainObject(response)) return false
  const data = isPlainObject(response['data']) ? response['data'] : {}
  const message = [response['message'], response['msg'], data['message'], data['msg']]
    .find((value): value is string => typeof value === 'string' && value !== '')
    ?.toLowerCase() ?? ''
  return ['unauthorized', '401', '登录', '失效', '过期', 'token'].some((needle) => message.includes(needle.toLowerCase()))
}

export function isTransportError(response: unknown): boolean {
  return responseCode(response) === -1 && isPlainObject(response) && typeof response['message'] === 'string' && response['message'] !== ''
}

// -------------------------------------------------------- nested extraction

export function extractNestedArray(response: unknown, camel: 'Accounts' | 'Packages'): unknown[] | undefined {
  if (!isPlainObject(response)) return undefined
  const lower = camel === 'Accounts' ? 'accounts' : 'packages'
  const paths: unknown[][] = []
  const data = response['data']
  const dataData = isPlainObject(data) ? data['data'] : undefined
  const responseData = isPlainObject(data) && isPlainObject(data['Response']) ? data['Response']['Data'] : undefined
  const dataResponseData =
    isPlainObject(data) && isPlainObject(data['data']) && isPlainObject((data['data'] as Record<string, unknown>)['Response'])
      ? ((data['data'] as Record<string, unknown>)['Response'] as Record<string, unknown>)['Data']
      : undefined
  for (const container of [response, data, dataData, responseData, dataResponseData]) {
    if (isPlainObject(container) && Array.isArray(container[camel])) paths.push(container[camel] as unknown[])
    if (isPlainObject(container) && Array.isArray(container[lower])) paths.push(container[lower] as unknown[])
  }
  return paths[0]
}

function numberOrNumericString(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function sliceDetail(raw: Record<string, unknown>): Record<string, unknown> {
  const details = raw['SlicePeriodUsageDetails'] ?? raw['slicePeriodUsageDetails']
  if (Array.isArray(details) && isPlainObject(details[0])) return details[0] as Record<string, unknown>
  return {}
}

function firstNumber(raw: Record<string, unknown>, slice: Record<string, unknown>, keys: string[]): number | undefined {
  for (const source of [raw, slice]) {
    for (const key of keys) {
      const value = numberOrNumericString(source[key])
      if (value !== undefined) return value
    }
  }
  return undefined
}

export interface ResourceSummary {
  packageCode?: string
  packageName?: string
  total: number
  remaining: number
  used: number
  status?: unknown
  expireAt: number | null
  expired: boolean
  expiringSoon: boolean
}

export function resourceSummary(raw: Record<string, unknown>, now: number): ResourceSummary {
  const slice = sliceDetail(raw)
  const rawTotal = firstNumber(raw, slice, [
    'CycleCapacitySizePrecise', 'CycleCapacitySize', 'CycleTotalCapacity', 'CapacitySizePrecise', 'CapacitySize',
    'SlicePeriodCapacitySizePrecise', 'SlicePeriodCapacitySize',
  ])
  const rawRemaining = firstNumber(raw, slice, [
    'CycleCapacityRemainPrecise', 'CycleCapacityRemain', 'CycleRemainCapacity', 'CapacityRemainPrecise',
    'CapacityRemain', 'SlicePeriodCapacityRemainPrecise', 'SlicePeriodCapacityRemain',
  ])
  const rawUsed = firstNumber(raw, slice, [
    'CycleCapacityUsedPrecise', 'CycleCapacityUsed', 'CycleUsedCapacity', 'CapacityUsedPrecise', 'CapacityUsed',
    'SlicePeriodCapacityUsedPrecise', 'SlicePeriodCapacityUsed',
  ])
  const total = Math.max(rawTotal ?? (rawRemaining ?? 0) + (rawUsed ?? 0) ?? 0, 0)
  const remaining = Math.max(rawRemaining ?? total - (rawUsed ?? 0), 0)
  const used = Math.max(rawUsed ?? total - remaining, 0)
  const expireAt = resolveExpireAt(raw, now)
  const status = raw['Status'] ?? raw['status']
  const packageName = [raw['PackageName'], raw['packageName']].find((value): value is string => typeof value === 'string')
  const packageCode = [raw['PackageCode'], raw['packageCode']].find((value): value is string => typeof value === 'string')
  return {
    ...(packageCode !== undefined ? { packageCode } : {}),
    ...(packageName !== undefined ? { packageName } : {}),
    total,
    remaining,
    used,
    status,
    expireAt,
    expired: expireAt !== null && expireAt <= now,
    expiringSoon: expireAt !== null && expireAt > now && expireAt - now <= EXPIRING_SOON_DAYS * 86_400_000,
  }
}

export function mergeResources(details: ResourceSummary[], summaries: ResourceSummary[]): ResourceSummary[] {
  const merged = [...details]
  for (const summary of summaries) {
    const code = summary.packageCode
    if (code !== undefined && merged.some((entry) => entry.packageCode === code)) continue
    merged.push(summary)
  }
  return merged
}

// -------------------------------------------------------------- aggregation

export interface CreditResult {
  ok: true
  accountId: string | null
  accountName: string
  updatedAt: number
  totalCapacity: number
  totalRemaining: number
  expiringSoonRemaining: number
  expiredRemaining: number
  soonestExpireAt: number | null
  expiringSoon: boolean
  expired: boolean
  resources: ResourceSummary[]
}

export function creditResult(account: WbAccount, resources: ResourceSummary[], now: number): CreditResult {
  const totalCapacity = resources.reduce((sum, entry) => sum + entry.total, 0)
  const totalRemaining = resources.reduce((sum, entry) => sum + entry.remaining, 0)
  const expiringSoonRemaining = resources.reduce((sum, entry) => sum + (entry.expiringSoon && entry.remaining > 0 ? entry.remaining : 0), 0)
  const expiredRemaining = resources.reduce((sum, entry) => sum + (entry.expired && entry.remaining > 0 ? entry.remaining : 0), 0)
  const soonest = resources
    .filter((entry) => entry.remaining > 0 && entry.expireAt !== null)
    .reduce((min, entry) => Math.min(min, entry.expireAt!), Number.POSITIVE_INFINITY)
  return {
    ok: true,
    accountId: getStr(account, 'id') ?? null,
    accountName: getStr(account, 'email') ?? getStr(account, 'nickname') ?? getStr(account, 'uid') ?? 'unknown',
    updatedAt: now,
    totalCapacity,
    totalRemaining,
    expiringSoonRemaining,
    expiredRemaining,
    soonestExpireAt: Number.isFinite(soonest) ? soonest : null,
    expiringSoon: expiringSoonRemaining > 0,
    expired: expiredRemaining > 0,
    resources,
  }
}

export interface CreditFailure {
  ok: false
  accountId: string | null
  accountName: string
  error: string
}

export function envelopeShortCircuit(account: WbAccount): CreditFailure | undefined {
  const error = envelopeTokenError(account)
  if (error === undefined) return undefined
  return {
    ok: false,
    accountId: getStr(account, 'id') ?? null,
    accountName: getStr(account, 'email') ?? getStr(account, 'nickname') ?? 'unknown',
    error,
  }
}

// ------------------------------------------------------------------ routing

export function apiBaseFor(account: WbAccount): string {
  if (variantOf(account) === 'ai') return AI_API_ENDPOINT
  const domain = (getStr(account, 'domain') ?? '').toLowerCase()
  return domain === 'workbuddy.cn' || domain === 'www.workbuddy.cn' ? WORKBUDDY_WEB_ENDPOINT : variantApiEndpoint('cn')
}

export function requestOrigin(url: string): string {
  for (const candidate of [AI_API_ENDPOINT, WORKBUDDY_WEB_ENDPOINT, variantApiEndpoint('cn')]) {
    if (url === candidate || url.startsWith(`${candidate}/`)) return candidate
  }
  return variantApiEndpoint('cn')
}

export function resourceAuthHeaders(account: WbAccount, url: string, buildAuthHeaders: (account: WbAccount) => Record<string, string>): Record<string, string> {
  const origin = requestOrigin(url)
  return {
    ...buildAuthHeaders(account),
    'X-Client-Platform': 'web',
    Accept: 'application/json, text/plain, */*',
    Origin: origin,
    Referer: `${origin}/profile/plans-usage`,
  }
}

export function legacyCreditCandidates(variant: WbVariant): string[] {
  return variantBillingPaths(variant, '/v2/billing/meter/get-user-resource')
}

export function usesThreeEndpointQuery(variant: WbVariant): boolean {
  return variant === 'cn' && supportsCheckin(variant)
}
