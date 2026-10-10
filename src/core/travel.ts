/**
 * Port of wbs `modules/travel.rs` — cat-travel state machine, depart error
 * classification, cache merge semantics and display labels. HTTP injected.
 * International (ai) accounts are unsupported and skip without any request.
 */
import { supportsTravel, type WbVariant } from './variant.ts'

export const TRAVEL_API_PREFIX = '/activity/growth/buddy/travel'
export const KNOWN_STATES = ['idle', 'traveling', 'arrived'] as const

export type TravelState = (typeof KNOWN_STATES)[number]

export function parseTravelState(value: unknown): TravelState | undefined {
  if (typeof value !== 'string') return undefined
  const lowered = value.trim().toLowerCase()
  return (KNOWN_STATES as readonly string[]).includes(lowered) ? (lowered as TravelState) : undefined
}

export type TravelAction = 'claim' | 'wait' | 'skip-daily-limit' | 'depart' | 'status-error'

export function decideTravelAction(state: TravelState, dailyLimitReached: boolean): TravelAction {
  if (state === 'arrived') return 'claim'
  if (state === 'traveling') return 'wait'
  return dailyLimitReached ? 'skip-daily-limit' : 'depart'
}

export type DepartErrorClass = 'already-traveling' | 'daily-limit' | 'no-buddy' | 'location-unavailable' | 'other'

/** Message-text decides (HTTP 429 is Other/retryable, never DailyLimit). */
export function classifyDepartError(_code: number | undefined, message: string): DepartErrorClass {
  const lowered = message.toLowerCase()
  if (lowered.includes('already traveling')) return 'already-traveling'
  if (lowered.includes('daily limit') || lowered.includes('daily_limit')) return 'daily-limit'
  if (lowered.includes('no active buddy')) return 'no-buddy'
  if (lowered.includes('location not available')) return 'location-unavailable'
  return 'other'
}

export function truncateMessage(message: string, max = 80): string {
  return message.length <= max ? message : message.slice(0, max)
}

// ------------------------------------------------------------------ cache

export interface TravelRecord {
  accountId: string
  uid?: string | null
  ok?: boolean | null
  already?: boolean
  claimed?: boolean
  claimedAt?: number
  skip?: string
  state?: string
  message?: string
  locationName?: string
  rewardCredit?: number | null
  arriveAt?: number | null
  at: number
}

export interface TravelCache {
  date: string
  completed: boolean
  results: Record<string, TravelRecord>
}

const RETRYABLE_SKIPS = new Set(['no-buddy', 'error', 'config-error', 'no-location', 'location-unavailable', 'status-error'])

export function isRetryableSkip(record: TravelRecord): boolean {
  return record.skip !== undefined && RETRYABLE_SKIPS.has(record.skip)
}

export function hasRetryableResults(cache: TravelCache): boolean {
  return Object.values(cache.results).some(isRetryableSkip)
}

/** Date roll keeps only in-flight (ok && !claimed) records. */
export function rollCacheToToday(cache: TravelCache, today: string): TravelCache {
  if (cache.date === today) return cache
  const results: Record<string, TravelRecord> = {}
  for (const [id, record] of Object.entries(cache.results)) {
    if (record.ok === true && record.claimed !== true) results[id] = record
  }
  return { date: today, completed: false, results }
}

export function mergeClaimState(prior: TravelRecord | undefined, next: TravelRecord): TravelRecord {
  if (prior === undefined) return next
  const priorInFlight = prior.ok === true && prior.claimed !== true
  const nextInFlight = next.ok === true && next.claimed !== true
  if (nextInFlight && priorInFlight) {
    return {
      ...next,
      locationName: next.locationName ?? prior.locationName,
      rewardCredit: next.rewardCredit ?? prior.rewardCredit,
      arriveAt: next.arriveAt ?? prior.arriveAt,
    }
  }
  if (prior.claimed === true) {
    return {
      ...next,
      claimed: true,
      claimedAt: next.claimedAt ?? prior.claimedAt,
      rewardCredit: next.rewardCredit ?? prior.rewardCredit,
      locationName: next.locationName ?? prior.locationName,
      state: 'idle',
    }
  }
  return next
}

export function mergeTravelCache(cache: TravelCache, overlay: Record<string, TravelRecord>): TravelCache {
  const results: Record<string, TravelRecord> = { ...cache.results }
  for (const [id, record] of Object.entries(overlay)) {
    results[id] = mergeClaimState(results[id], record)
  }
  const merged: TravelCache = { ...cache, results }
  merged.completed = !hasRetryableResults(merged)
  return merged
}

export function inFlightDue(record: TravelRecord, nowSecs: number): boolean {
  if (record.claimed === true) return false
  if (record.arriveAt === undefined || record.arriveAt === null) return true
  // arriveAt may be stored in ms (>1e12) or seconds
  const arriveSecs = record.arriveAt > 1e12 ? Math.floor(record.arriveAt / 1000) : record.arriveAt
  return arriveSecs <= nowSecs
}

// ---------------------------------------------------------------- display

export type TravelLabel = 'untraveled' | 'traveling' | 'no-buddy' | 'finished' | 'unsupported'

export function travelDisplayLabel(accountVariant: WbVariant, cache: TravelCache | undefined, accountId: string, today: string): TravelLabel {
  if (!supportsTravel(accountVariant)) return 'unsupported'
  if (cache === undefined || cache.date !== today) return 'untraveled'
  const record = cache.results[accountId]
  if (record === undefined) return 'untraveled'
  if (record.ok === true && record.claimed !== true) return 'traveling'
  if (record.skip === 'no-buddy') return 'no-buddy'
  if (record.claimed === true || (record.skip === 'daily-limit')) return 'finished'
  return 'untraveled'
}
