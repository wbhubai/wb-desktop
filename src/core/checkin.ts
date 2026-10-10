/**
 * Port of wbs `modules/checkin.rs` — the pure scheduling core: window parsing,
 * deterministic target minute, due logic, retry planning, cycle health and
 * status decision. HTTP is injected.
 */
import { parseClock, nowMs } from './util.ts'

export interface CheckinConfig {
  enabled: boolean
  excluded_account_ids: string[]
  checkin_start: string
  checkin_end: string
  keepalive_days: number
}

export function defaultCheckinConfig(legacyUsageTrace = false): CheckinConfig {
  return {
    enabled: legacyUsageTrace,
    excluded_account_ids: [],
    checkin_start: '',
    checkin_end: '',
    keepalive_days: 0,
  }
}

/** Strict "HH:MM" window; start < end; none/invalid = unrestricted. */
export function windowMinutes(config: CheckinConfig): [number, number] | undefined {
  const start = parseClock(config.checkin_start)
  const end = parseClock(config.checkin_end)
  if (!start || !end) return undefined
  const startMin = start[0] * 60 + start[1]
  const endMin = end[0] * 60 + end[1]
  return startMin < endMin ? [startMin, endMin] : undefined
}

/** Deterministic FNV-1a (Rust uses SipHash; only determinism + spread matter). */
export function hashToMinute(day: string, accountKey: string, start: number, end: number): number {
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(day + '\u0000' + accountKey, 'utf8')) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return start + Number(hash % BigInt(end - start))
}

export function localDayString(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function targetAt(day: string, minute: number): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined
  if (minute < 0 || minute >= 1440) return undefined
  const at = new Date(`${day}T00:00:00`)
  if (Number.isNaN(at.getTime())) return undefined
  at.setHours(Math.floor(minute / 60), minute % 60, 0, 0)
  return at.getTime()
}

export interface CheckinLogRow {
  ts: number
  accountId?: string | null
  email?: string | null
  variant?: string
  result: 'success' | 'already' | 'error'
  error?: string
}

function answeredWindow(logs: CheckinLogRow[], account: { id?: string; displayName: string }, since: number): boolean {
  return logs.some((row) => {
    if (row.ts < since) return false
    if (row.result !== 'success' && row.result !== 'already') return false
    const id = account.id
    if (id) return row.accountId === id
    // legacy rows without stable ids match display name with empty accountId
    return (row.accountId === null || row.accountId === undefined || row.accountId === '') && row.email === account.displayName
  })
}

export interface DueAccountInput {
  id?: string
  displayName: string
  excluded: boolean
  supportsCheckin: boolean
}

export function latestTargetMs(now: number, win: [number, number], accountKey: string): number | undefined {
  const today = localDayString(now)
  const todayTarget = targetAt(today, hashToMinute(today, accountKey, win[0], win[1]))
  if (todayTarget === undefined) return undefined
  if (now >= todayTarget) return todayTarget
  const yesterday = localDayString(now - 86_400_000)
  return targetAt(yesterday, hashToMinute(yesterday, accountKey, win[0], win[1]))
}

export function nextTargetMs(now: number, win: [number, number], accountKey: string): number | undefined {
  const today = localDayString(now)
  const todayTarget = targetAt(today, hashToMinute(today, accountKey, win[0], win[1]))
  if (todayTarget !== undefined && now < todayTarget) return todayTarget
  const tomorrow = localDayString(now + 86_400_000)
  return targetAt(tomorrow, hashToMinute(tomorrow, accountKey, win[0], win[1]))
}

export function accountDue(
  now: number,
  account: DueAccountInput,
  win: [number, number] | undefined,
  logs: CheckinLogRow[],
): boolean {
  if (win === undefined) return true
  const latest = latestTargetMs(now, win, account.id ?? account.displayName)
  // unresolvable target is treated as due (conservative)
  return latest === undefined ? true : !answeredWindow(logs, account, latest)
}

export function dueAccounts(accounts: DueAccountInput[], now: number, win: [number, number] | undefined, logs: CheckinLogRow[]): DueAccountInput[] {
  const eligible = accounts.filter((account) => account.supportsCheckin && !account.excluded)
  return win === undefined ? eligible : eligible.filter((account) => accountDue(now, account, win, logs))
}

// ---------------------------------------------------------- cycle planning

export const CHECKIN_RECOVERY_INTERVAL_MS = 30 * 60_000
export const FAST_RETRY_INTERVAL_MS = 5 * 60_000
export const FAST_RETRY_MAX = 12
export const MIN_CYCLE_DELAY_MS = 60_000

/** plan_next_delay: no window → 30min; errors consume fast-retry budget; else wake at next target. */
export function planNextDelay(
  hadErrors: boolean,
  budget: number,
  now: number,
  accounts: DueAccountInput[],
  win: [number, number] | undefined,
  logs: CheckinLogRow[],
): { delayMs: number; budget: number } {
  if (win === undefined) return { delayMs: CHECKIN_RECOVERY_INTERVAL_MS, budget }
  if (hadErrors && budget > 0) return { delayMs: FAST_RETRY_INTERVAL_MS, budget: budget - 1 }
  const nearest = accounts
    .map((account) => nextTargetMs(now, win, account.id ?? account.displayName))
    .filter((value): value is number => value !== undefined)
    .reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY)
  if (!Number.isFinite(nearest)) return { delayMs: CHECKIN_RECOVERY_INTERVAL_MS, budget }
  const delay = Math.min(Math.max(nearest - now, 0), CHECKIN_RECOVERY_INTERVAL_MS)
  return { delayMs: Math.max(delay, MIN_CYCLE_DELAY_MS), budget }
}

// ---------------------------------------------------------- status decision

export interface CheckinStatusResponse {
  ok: boolean
  todayCheckedIn?: boolean
  error?: string
  statusUnsupported?: boolean
}

export type CheckinDecision =
  | { action: 'submit' }
  | { action: 'already' }
  | { action: 'error'; error: string }

export function decideFromStatus(status: CheckinStatusResponse): CheckinDecision {
  if (status.statusUnsupported === true) return { action: 'submit' } // daily-checkin is idempotent
  if (!status.ok) return { action: 'error', error: status.error ?? '查询签到状态失败' }
  if (status.todayCheckedIn === true) return { action: 'already' }
  return { action: 'submit' }
}

export function isInactiveMessage(message: string): boolean {
  const lowered = message.toLowerCase()
  return ['未开启', '未开放', '已过期', 'inactive', 'not enabled', 'not available'].some((needle) => lowered.includes(needle))
}

export interface PerformCheckinResult {
  ok: boolean
  already?: boolean
  inactive?: boolean
  message?: string
  error?: string
}

export function performCheckinFromResponse(response: { code?: number; message?: string }): PerformCheckinResult {
  if (response.code === 0 || response.code === 200) return { ok: true }
  const message = response.message ?? ''
  if (message.includes('已签到') || message.toLowerCase().includes('repeat')) {
    return { ok: true, already: true, message }
  }
  return { ok: false, error: message }
}

export function isUnauthorized(response: { code?: number; message?: string }): boolean {
  if (response.code === 401 || response.code === 403) return true
  const lowered = (response.message ?? '').toLowerCase()
  return ['unauthorized', '401', '登录', '失效', '过期', 'token'].some((needle) => lowered.includes(needle))
}

/** Ring normalization: 30-day retention, dedupe legacy "already" rows (keep latest), cap 500. */
export function normalizeCheckinLogs(rows: CheckinLogRow[], at = nowMs()): CheckinLogRow[] {
  const cutoff = at - 30 * 86_400_000
  const kept = rows.filter((row) => row.ts >= cutoff && row.ts <= at)
  // dedupe legacy "already" rows per (identity, local date), keeping the LATEST
  const latestByKey = new Map<string, { row: CheckinLogRow; index: number }>()
  const out: (CheckinLogRow | undefined)[] = []
  for (const row of kept) {
    if (row.result !== 'already') {
      out.push(row)
      continue
    }
    const identity = row.accountId || `legacy:${row.email ?? ''}`
    const key = `${identity}|${localDayString(row.ts)}`
    const previous = latestByKey.get(key)
    if (previous !== undefined) {
      out[previous.index] = undefined
    }
    latestByKey.set(key, { row, index: out.length })
    out.push(row)
  }
  const deduped = out.filter((row): row is CheckinLogRow => row !== undefined)
  return deduped.length > 500 ? deduped.slice(deduped.length - 500) : deduped
}
