import { describe, expect, it } from 'vitest'
import {
  accountDue,
  decideFromStatus,
  defaultCheckinConfig,
  dueAccounts,
  hashToMinute,
  isInactiveMessage,
  isUnauthorized,
  latestTargetMs,
  localDayString,
  normalizeCheckinLogs,
  nextTargetMs,
  performCheckinFromResponse,
  planNextDelay,
  targetAt,
  windowMinutes,
  type CheckinLogRow,
} from './checkin.ts'

const NOW = new Date('2026-09-29T22:00:00').getTime()
const TEST_WINDOW: [number, number] = [22 * 60, 23 * 60 + 30]
const DAY = '2026-09-29'

const acc = (id: string, overrides: Record<string, unknown> = {}) => ({ id, displayName: `name-${id}`, excluded: false, supportsCheckin: true, ...overrides })

/** The account's own deterministic target for a day (mirrors the scheduler). */
const targetFor = (accountKey: string, day: string) => targetAt(day, hashToMinute(day, accountKey, TEST_WINDOW[0], TEST_WINDOW[1]))!

describe('window parsing', () => {
  it('requires both bounds and start before end', () => {
    const configs = [
      { checkin_start: '22:00', checkin_end: '' },
      { checkin_start: '', checkin_end: '23:00' },
      { checkin_start: '23:00', checkin_end: '22:00' },
      { checkin_start: '24:00', checkin_end: '23:30' },
      { checkin_start: '22:00:00', checkin_end: '23:00' },
    ]
    for (const partial of configs) {
      expect(windowMinutes({ ...defaultCheckinConfig(), ...partial })).toBeUndefined()
    }
    expect(windowMinutes({ ...defaultCheckinConfig(), checkin_start: '22:00', checkin_end: '23:30' })).toEqual([1320, 1410])
    expect(windowMinutes({ ...defaultCheckinConfig(), checkin_start: '9:5', checkin_end: '10:00' })).toEqual([545, 600])
    expect(windowMinutes({ ...defaultCheckinConfig(), checkin_start: '0:0', checkin_end: '1:0' })).toEqual([0, 60])
  })
})

describe('target minute', () => {
  it('is stable, inside the window, and spread across accounts/days', () => {
    const a1 = hashToMinute(DAY, 'acc-a', 1320, 1410)
    const a2 = hashToMinute(DAY, 'acc-a', 1320, 1410)
    expect(a1).toBe(a2)
    expect(a1).toBeGreaterThanOrEqual(1320)
    expect(a1).toBeLessThan(1410)
    expect(hashToMinute('d', 'k', 60, 61)).toBe(60)
    expect(hashToMinute('d', 'k', 1439, 1440)).toBe(1439)
    const spread = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((key) => hashToMinute(DAY, key, 1320, 1410)))
    expect(spread.size).toBeGreaterThan(1)
    expect(hashToMinute(DAY, 'a', 1320, 1410) === hashToMinute('2026-09-30', 'a', 1320, 1410)).toBe(false)
  })
  it('latest/next target boundaries are stable', () => {
    const todayTarget = targetFor('k', DAY)
    const yesterdayTarget = targetFor('k', '2026-09-28')
    const tomorrowTarget = targetFor('k', '2026-09-30')
    expect(latestTargetMs(todayTarget - 1, TEST_WINDOW, 'k')).toBe(yesterdayTarget)
    expect(latestTargetMs(todayTarget, TEST_WINDOW, 'k')).toBe(todayTarget)
    expect(latestTargetMs(todayTarget + 1, TEST_WINDOW, 'k')).toBe(todayTarget)
    expect(nextTargetMs(todayTarget - 1, TEST_WINDOW, 'k')).toBe(todayTarget)
    expect(nextTargetMs(todayTarget + 1, TEST_WINDOW, 'k')).toBe(tomorrowTarget)
    expect(targetAt('not-a-date', 0)).toBeUndefined()
    expect(targetAt(DAY, 1440)).toBeUndefined()
  })
})

describe('due logic', () => {
  it('waits for today target then fires; answered targets suppress', () => {
    const target = targetFor('a', DAY)
    const yesterday = targetFor('a', '2026-09-28')
    const account = acc('a')
    const answeredYesterday: CheckinLogRow[] = [{ ts: yesterday + 60_000, accountId: 'a', result: 'success' }]
    // before today's target, latest window is yesterday's — answered → not due
    expect(accountDue(target - 1, account, TEST_WINDOW, answeredYesterday)).toBe(false)
    // after today's target with today unanswered → due
    expect(accountDue(target + 1, account, TEST_WINDOW, answeredYesterday)).toBe(true)
    // answered today's target → not due
    const logs: CheckinLogRow[] = [{ ts: target + 60_000, accountId: 'a', result: 'already' }]
    expect(accountDue(target + 120_000, account, TEST_WINDOW, logs)).toBe(false)
  })
  it('missed window and new accounts are due immediately', () => {
    const morning = new Date('2026-09-30T08:00:00').getTime()
    // an answer from the day BEFORE yesterday never covers the latest window
    const olderAnswer: CheckinLogRow[] = [{ ts: targetFor('a', '2026-09-27') + 60_000, accountId: 'a', result: 'success' }]
    expect(accountDue(morning, acc('a'), TEST_WINDOW, olderAnswer)).toBe(true)
    // brand-new accounts are due at once
    expect(accountDue(morning, acc('new'), TEST_WINDOW, [])).toBe(true)
  })
  it('window receipt matches same account after target only', () => {
    const legacyTarget = targetFor('name-a', DAY)
    const account = { displayName: 'name-a', excluded: false, supportsCheckin: true }
    const beforeRow: CheckinLogRow[] = [{ ts: legacyTarget - 5000, accountId: null, email: 'name-a', result: 'already' }]
    expect(accountDue(legacyTarget + 1000, account, TEST_WINDOW, beforeRow)).toBe(true)
    const afterRow: CheckinLogRow[] = [{ ts: legacyTarget + 1000, accountId: null, email: 'name-a', result: 'already' }]
    expect(accountDue(legacyTarget + 2000, account, TEST_WINDOW, afterRow)).toBe(false)
    // a named account does not match empty-accountId rows for another name
    const other: CheckinLogRow[] = [{ ts: legacyTarget + 1000, accountId: null, email: 'name-other', result: 'already' }]
    expect(accountDue(legacyTarget + 2000, account, TEST_WINDOW, other)).toBe(true)
    // a named account (with id) does not match an empty-accountId row
    const withId = { id: 'a', displayName: 'name-a', excluded: false, supportsCheckin: true }
    expect(accountDue(legacyTarget + 2000, withId, TEST_WINDOW, afterRow)).toBe(true)
  })
  it('excluded and non-checkin accounts are filtered', () => {
    const all = [acc('a', { excluded: true }), acc('b'), acc('c', { supportsCheckin: false })]
    expect(dueAccounts(all, NOW, TEST_WINDOW, []).map((entry) => entry.id)).toEqual(['b'])
    expect(dueAccounts(all, NOW, undefined, []).map((entry) => entry.id)).toEqual(['b'])
  })
  it('unset window never filters accounts', () => {
    expect(dueAccounts([acc('a'), acc('b')], NOW, undefined, [])).toHaveLength(2)
  })
})

describe('cycle planning', () => {
  const accounts = [acc('a'), acc('b')]
  it('no window → 30min recovery, budget untouched', () => {
    expect(planNextDelay(true, 5, NOW, accounts, undefined, [])).toEqual({ delayMs: 30 * 60_000, budget: 5 })
  })
  it('errors consume the fast-retry budget; clean cycles wake at the next target', () => {
    expect(planNextDelay(true, 5, NOW, accounts, TEST_WINDOW, [])).toEqual({ delayMs: 5 * 60_000, budget: 4 })
    expect(planNextDelay(true, 1, NOW, accounts, TEST_WINDOW, []).budget).toBe(0)
    // exhausted budget falls back to the nearest-target clamp
    const exhausted = planNextDelay(true, 0, NOW, accounts, TEST_WINDOW, [])
    expect(exhausted.delayMs).toBeGreaterThanOrEqual(60_000)
    expect(exhausted.delayMs).toBeLessThanOrEqual(30 * 60_000)
    const planned = planNextDelay(false, 5, NOW, accounts, TEST_WINDOW, [])
    expect(planned.delayMs).toBeGreaterThanOrEqual(60_000)
    expect(planned.delayMs).toBeLessThanOrEqual(30 * 60_000)
    expect(nextTargetMs(NOW, TEST_WINDOW, 'a')).toBeGreaterThan(0)
  })
})

describe('status decisions', () => {
  it('checked-in status returns already without submission', () => {
    expect(decideFromStatus({ ok: true, todayCheckedIn: true })).toEqual({ action: 'already' })
  })
  it('failed status returns error without submission', () => {
    expect(decideFromStatus({ ok: false, error: 'offline' })).toEqual({ action: 'error', error: 'offline' })
  })
  it('unchecked status submits; unsupported status submits once', () => {
    expect(decideFromStatus({ ok: true, todayCheckedIn: false })).toEqual({ action: 'submit' })
    expect(decideFromStatus({ ok: true, statusUnsupported: true })).toEqual({ action: 'submit' })
  })
  it('inactive messages are recognized', () => {
    for (const message of ['功能未开启', '活动未开放', '资格已过期', 'Inactive', 'not enabled', 'not available']) {
      expect(isInactiveMessage(message)).toBe(true)
    }
    expect(isInactiveMessage('签到成功')).toBe(false)
    expect(isInactiveMessage('')).toBe(false)
  })
  it('unauthorized detection covers codes and messages', () => {
    expect(isUnauthorized({ code: 401 })).toBe(true)
    expect(isUnauthorized({ code: 403 })).toBe(true)
    expect(isUnauthorized({ code: 0 })).toBe(false)
    expect(isUnauthorized({ code: 500, message: '登录已失效' })).toBe(true)
  })
  it('perform maps success/already/error', () => {
    expect(performCheckinFromResponse({ code: 0 })).toEqual({ ok: true })
    expect(performCheckinFromResponse({ code: 500, message: '已签到' })).toMatchObject({ ok: true, already: true })
    expect(performCheckinFromResponse({ code: 500, message: 'duplicate REPEAT' })).toMatchObject({ ok: true, already: true })
    expect(performCheckinFromResponse({ code: 500, message: 'boom' })).toMatchObject({ ok: false, error: 'boom' })
  })
})

describe('log normalization', () => {
  it('dedupes legacy already rows per identity+day keeping latest, applies retention and cap', () => {
    const at = new Date('2026-09-29T12:00:00').getTime()
    const day = (index: number) => at - index * 86_400_000
    const rows: CheckinLogRow[] = [
      { ts: at - 2000, accountId: 'a', result: 'already' },
      { ts: at - 1000, accountId: 'a', result: 'already' },
      { ts: at - 2000, accountId: null, email: 'legacy', result: 'already' },
      { ts: at - 1500, accountId: null, email: 'legacy', result: 'already' },
      { ts: at - 500, accountId: 'b', result: 'success' },
      { ts: at - 40 * 86_400_000, accountId: 'c', result: 'success' },
    ]
    const normalized = normalizeCheckinLogs(rows, at)
    const aRows = normalized.filter((row) => row.accountId === 'a' && row.result === 'already')
    expect(aRows).toHaveLength(1)
    expect(aRows[0]!.ts).toBe(at - 1000) // latest kept
    expect(normalized.filter((row) => row.email === 'legacy')).toHaveLength(1)
    expect(normalized.some((row) => row.accountId === 'c')).toBe(false)
    expect(normalized.some((row) => row.accountId === 'b')).toBe(true)
    const base = day(1)
    const cap = normalizeCheckinLogs(
      Array.from({ length: 600 }, (_, index) => ({ ts: base - 600_000 + index, accountId: `u${index}`, result: 'success' as const })),
      at,
    )
    expect(cap).toHaveLength(500)
    expect(normalizeCheckinLogs(cap, at)).toEqual(cap) // idempotent
  })
})

describe('config defaults', () => {
  it('fresh installs are disabled, legacy traces enable', () => {
    expect(defaultCheckinConfig(false).enabled).toBe(false)
    expect(defaultCheckinConfig(true).enabled).toBe(true)
    expect(localDayString(new Date('2026-09-29T23:30:00').getTime())).toBe('2026-09-29')
  })
})
