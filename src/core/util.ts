/**
 * Port of wbs `modules/config.rs` helpers: time utilities, the "HH:MM" clock
 * parser, timestamp normalization, route-missing detection and error-body
 * normalization.
 */

export function nowMs(): number {
  return Date.now()
}

export function nowSecs(): number {
  return Math.floor(Date.now() / 1000)
}

/** Filesystem-safe UTC timestamp with dashes: 2026-09-15T00-00-00Z */
export function utcIso(at = Date.now()): string {
  return `${new Date(at).toISOString().slice(0, 19).replace(/:/g, '-')}` + 'Z'
}

/** Numbers or numeric strings; values < 1e10 are seconds and get x1000. */
export function normTs(value: unknown): number | null {
  let numeric: number | undefined
  if (typeof value === 'number' && Number.isFinite(value)) numeric = value
  else if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) numeric = parsed
  }
  if (numeric === undefined) return null
  const ms = Math.trunc(numeric)
  return Math.abs(ms) < 10_000_000_000 ? ms * 1000 : ms
}

/** Port of wbs `parse_clock`: 1-2 digit hour/minute, hour<=23, minute<=59. */
export function parseClock(raw: unknown): [number, number] | null {
  if (typeof raw !== 'string') return null
  const colon = raw.indexOf(':')
  if (colon < 0) return null
  const hour = raw.slice(0, colon)
  const minute = raw.slice(colon + 1)
  if (!/^\d{1,2}$/.test(hour) || !/^\d{1,2}$/.test(minute)) return null
  const h = Number(hour)
  const m = Number(minute)
  if (h > 23 || m > 59) return null
  return [h, m]
}

/** Zero-pads a valid clock, maps invalid values to "" (unrestricted). */
export function normalizeClockField(raw: unknown): string {
  const parsed = parseClock(raw)
  if (!parsed) return ''
  const [h, m] = parsed
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Top-level or `data.code`; numeric or numeric-string; 404 only allows path fallback. */
export function responseCode(response: unknown): number | null {
  if (!isPlainObject(response)) return null
  const direct = numericOf(response['code'])
  if (direct !== null) return direct
  if (isPlainObject(response['data'])) return numericOf(response['data']['code'])
  return null
}

function numericOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Math.trunc(Number(value))
  return null
}

export function isRouteMissing(response: unknown): boolean {
  return responseCode(response) === 404
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/** HTML error pages become `服务端返回 HTML 错误页：<title>`; else capped at 500 chars. */
export function normalizeErrorBody(text: string): string {
  const body = text.trim()
  if (body.startsWith('<')) {
    const title = /<title>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim()
    return title ? `服务端返回 HTML 错误页：${title}` : '服务端返回 HTML 错误页（无标题）'
  }
  return truncate(body, 500)
}

export const DEFAULT_HTTP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

export const HTTP_TIMEOUT_MS = 30_000

/**
 * JSON response envelope mirroring wbs `http_request`: success → parsed body
 * (or null); non-2xx → `{code: <status>, message}`; transport error →
 * `{code: -1, message}`.
 */
export type HttpEnvelope = Record<string, unknown>

export type HttpFetcher = (
  url: string,
  method: 'GET' | 'POST',
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<HttpEnvelope>

export const fetchHttp: HttpFetcher = async (url, method, body, headers) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'User-Agent': DEFAULT_HTTP_USER_AGENT, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    if (response.ok) {
      try {
        return JSON.parse(text) as HttpEnvelope
      } catch {
        return null as unknown as HttpEnvelope
      }
    }
    try {
      const parsed = JSON.parse(text)
      if (isPlainObject(parsed)) return parsed
      return { code: response.status, message: normalizeErrorBody(text) }
    } catch {
      return { code: response.status, message: normalizeErrorBody(text) }
    }
  } catch (error) {
    return { code: -1, message: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}
