/**
 * checkinCycle 端到端：调度、落盘和 HTTP 分支都走真实代码，只替换全局 fetch
 * 和 home 目录（数据目录随 os.homedir() 落到临时目录）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckinLogRow } from './core/checkin.ts'

const MINUTE = 60_000
const START = new Date('2026-11-06T09:00:00').getTime()
const NEXT_DAY = new Date('2026-11-07T08:30:00').getTime()
const STATUS = '/checkin-activity-status'
const SUBMIT = '/daily-checkin'
// 08:00–08:30 的所有目标分钟都早于 START，账号一开始就到期
const WINDOW = { checkin_start: '08:00', checkin_end: '08:30' }

type Reply = (url: string, token: string) => unknown

const account = (id: string, overrides: Record<string, unknown> = {}) => ({ id, email: `${id}@x.com`, access_token: `token-${id}`, variant: 'cn', ...overrides })
const unchecked: Reply = (url) => (url.endsWith(STATUS) ? { code: 0, data: { today_checked_in: false } } : { code: 0 })
const failing: Reply = () => ({ code: 500, message: 'service busy' })

const savedEnv = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] }
let home: string
let reply: Reply
let requests: { url: string; token: string }[]

const submits = () => requests.filter((request) => request.url.endsWith(SUBMIT))
const at = (time: number) => vi.setSystemTime(time)

async function boot(accounts: Record<string, unknown>[], config: Record<string, unknown> = {}) {
  vi.resetModules()
  const store = await import('./store.ts')
  // 账号文件只能写进临时 home，绝不能碰到真实的 ~/.wb-hub
  expect(store.DATA_DIR.startsWith(home)).toBe(true)
  await mkdir(store.DATA_DIR, { recursive: true })
  await writeFile(store.dataFile('accounts.json'), JSON.stringify(accounts))
  await store.writeConfig('checkin-config.json', { enabled: true, excluded_account_ids: [], checkin_start: '', checkin_end: '', keepalive_days: 0, ...config })
  const { checkinCycle, recentLogs } = await import('./app.ts')
  return { checkinCycle, recentLogs, logsFile: store.dataFile('checkin-logs.json'), logs: () => store.readList<CheckinLogRow>('checkin-logs.json') }
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'wb-checkin-'))
  process.env['HOME'] = home
  process.env['USERPROFILE'] = home
  requests = []
  reply = unchecked
  vi.useFakeTimers({ toFake: ['Date'], now: START })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
    const token = (init.headers['Authorization'] ?? '').replace('Bearer ', '')
    requests.push({ url, token })
    const body = reply(url, token)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 })
  })
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(home, { recursive: true, force: true })
})

describe('background check-in', () => {
  it('checks in every eligible account', async () => {
    const { checkinCycle } = await boot([account('a1'), account('a2')])
    await checkinCycle()
    expect(submits().map((request) => request.token)).toEqual(['token-a1', 'token-a2'])
  })

  it('does nothing while disabled', async () => {
    const { checkinCycle } = await boot([account('a1')], { enabled: false })
    await checkinCycle()
    expect(requests).toHaveLength(0)
  })

  it('leaves excluded accounts alone', async () => {
    const { checkinCycle } = await boot([account('a1'), account('a2')], { excluded_account_ids: ['a1'] })
    await checkinCycle()
    expect(submits().map((request) => request.token)).toEqual(['token-a2'])
  })

  it('leaves variants without check-in alone', async () => {
    const { checkinCycle } = await boot([account('a1', { variant: 'ai' })])
    await checkinCycle()
    expect(requests).toHaveLength(0)
  })

  it('records the outcome of the cycle', async () => {
    const { checkinCycle, logs } = await boot([account('a1')])
    await checkinCycle()
    expect((await logs()).map((row) => [row.accountId, row.result])).toEqual([['a1', 'success']])
  })

  it('records accounts the official client already checked in, without submitting', async () => {
    reply = () => ({ code: 0, data: { today_checked_in: true } })
    const { checkinCycle, logs } = await boot([account('a1')])
    await checkinCycle()
    expect(submits()).toHaveLength(0)
    expect((await logs()).map((row) => row.result)).toEqual(['already'])
  })
})

describe('without a time window', () => {
  it('contacts upstream once per account per local day', async () => {
    const { checkinCycle } = await boot([account('a1')])
    await checkinCycle()
    const perDay = requests.length
    expect(submits()).toHaveLength(1)
    for (const minutes of [1, 31, 120, 14 * 60]) {
      at(START + minutes * MINUTE)
      await checkinCycle()
    }
    expect(requests).toHaveLength(perDay)
    at(NEXT_DAY)
    await checkinCycle()
    expect(requests).toHaveLength(perDay * 2)
  })

  it('retries a failing account every 30 minutes, not every minute', async () => {
    reply = failing
    const { checkinCycle } = await boot([account('a1')])
    await checkinCycle()
    const perAttempt = requests.length
    expect(perAttempt).toBeGreaterThan(0)
    for (const minutes of [1, 29]) {
      at(START + minutes * MINUTE)
      await checkinCycle()
    }
    expect(requests).toHaveLength(perAttempt)
    at(START + 30 * MINUTE)
    await checkinCycle()
    expect(requests).toHaveLength(perAttempt * 2)
  })
})

describe('with a time window', () => {
  it('stays quiet once answered, until the next day', async () => {
    const { checkinCycle } = await boot([account('a1')], WINDOW)
    await checkinCycle()
    const perDay = requests.length
    expect(submits()).toHaveLength(1)
    for (const minutes of [1, 31, 6 * 60]) {
      at(START + minutes * MINUTE)
      await checkinCycle()
    }
    expect(requests).toHaveLength(perDay)
    at(NEXT_DAY)
    await checkinCycle()
    expect(requests).toHaveLength(perDay * 2)
  })

  it('retries failures on the 5-minute fast path', async () => {
    reply = failing
    const { checkinCycle } = await boot([account('a1')], WINDOW)
    await checkinCycle()
    const perAttempt = requests.length
    expect(perAttempt).toBeGreaterThan(0)
    at(START + 4 * MINUTE)
    await checkinCycle()
    expect(requests).toHaveLength(perAttempt)
    at(START + 5 * MINUTE)
    await checkinCycle()
    expect(requests).toHaveLength(perAttempt * 2)
  })

  it('falls back to 30 minutes when the fast retries run out, and a clean cycle restores them', async () => {
    reply = failing
    const { checkinCycle } = await boot([account('a1')], WINDOW)
    let time = START
    await checkinCycle()
    const perAttempt = requests.length
    for (let attempt = 0; attempt < 12; attempt++) {
      time += 5 * MINUTE
      at(time)
      await checkinCycle()
    }
    expect(requests).toHaveLength(perAttempt * 13)
    at(time + 5 * MINUTE)
    await checkinCycle()
    expect(requests).toHaveLength(perAttempt * 13)
    at(time + 30 * MINUTE)
    reply = unchecked
    await checkinCycle()
    expect(submits()).toHaveLength(1)
    reply = failing
    requests = []
    at(NEXT_DAY)
    await checkinCycle()
    const nextDayAttempt = requests.length
    expect(nextDayAttempt).toBeGreaterThan(0)
    at(NEXT_DAY + 5 * MINUTE)
    await checkinCycle()
    expect(requests).toHaveLength(nextDayAttempt * 2)
  })
})

describe('one account failing', () => {
  it('shows up in the run log, since nobody watches the background cycle', async () => {
    reply = (url, token) => (token === 'token-a1' ? failing(url, token) : unchecked(url, token))
    const { checkinCycle, recentLogs } = await boot([account('a1'), account('a2')])
    await checkinCycle()
    expect(recentLogs()[0]).toMatchObject({ level: 'warn', message: '签到循环完成（2 个账号，失败 1）' })
  })

  it('does not stop the accounts after it', async () => {
    reply = (url, token) => (token === 'token-a1' ? 'not json' : unchecked(url, token))
    const { checkinCycle } = await boot([account('a1'), account('a2')])
    await checkinCycle()
    expect(submits().map((request) => request.token)).toEqual(['token-a2'])
  })

  it('still schedules the retry when the result cannot be saved', async () => {
    const { checkinCycle, logsFile } = await boot([account('a1')])
    await mkdir(logsFile) // 目录占住文件名，写入必然失败
    await checkinCycle()
    const perAttempt = requests.length
    expect(perAttempt).toBeGreaterThan(0)
    at(START + MINUTE)
    await checkinCycle()
    expect(requests).toHaveLength(perAttempt)
  })

  it('still schedules the retry when the reply is malformed', async () => {
    reply = () => 'not json'
    const { checkinCycle } = await boot([account('a1')])
    await checkinCycle()
    const perAttempt = requests.length
    expect(perAttempt).toBeGreaterThan(0)
    at(START + MINUTE)
    await checkinCycle()
    expect(requests).toHaveLength(perAttempt)
  })
})

describe('manual check-in', () => {
  it('keeps its rows, so the background cycle does not repeat it', async () => {
    const { checkinCycle, logs } = await boot([account('a1')])
    await checkinCycle(true)
    expect((await logs()).map((row) => row.result)).toEqual(['success'])
    const perRun = requests.length
    at(START + 31 * MINUTE)
    await checkinCycle()
    expect(requests).toHaveLength(perRun)
  })

  it('always runs, even if already answered or waiting to retry', async () => {
    const { checkinCycle } = await boot([account('a1')])
    await checkinCycle()
    const perRun = requests.length
    await checkinCycle(true)
    expect(requests).toHaveLength(perRun * 2)
    reply = failing
    await checkinCycle(true)
    await checkinCycle(true)
    expect(requests.length).toBeGreaterThan(perRun * 2)
  })
})
