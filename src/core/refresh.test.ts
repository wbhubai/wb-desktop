import { describe, expect, it } from 'vitest'
import { refreshHeaders, refreshUrl, isTokenStale, runKeepaliveCycle, type KeepaliveRow } from './refresh.ts'
import type { WbAccount } from './account.ts'

describe('refresh url', () => {
  it('follows the account variant', () => {
    expect(refreshUrl('cn')).toBe('https://www.codebuddy.cn/v2/plugin/auth/token/refresh')
    expect(refreshUrl('ai')).toBe('https://www.workbuddy.ai/v2/plugin/auth/token/refresh')
  })
})

describe('refresh headers (AC11)', () => {
  it('always declare the plugin refresh source, with no platform header', () => {
    for (const account of [{ access_token: 'at', refresh_token: 'rt-value' }, { access_token: 'at', refresh_token: 'rt-value', variant: 'cn' }, { access_token: 'at', refresh_token: 'rt-value', variant: 'ai' }] as WbAccount[]) {
      const headers = refreshHeaders(account, 'rt-value')
      expect(headers['X-Auth-Refresh-Source']).toBe('plugin')
      expect(headers['X-Refresh-Token']).toBe('rt-value')
      expect(headers['platform']).toBeUndefined()
      expect(headers['Authorization']).toBe('Bearer at')
    }
  })
})

describe('stale detection', () => {
  const NOW = 1_700_000_000_000
  it('missing expiry is stale; within window is fresh', () => {
    expect(isTokenStale({}, 24, NOW)).toBe(true)
    expect(isTokenStale({ expiresAt: NOW + 48 * 3_600_000 }, 24, NOW)).toBe(false)
    expect(isTokenStale({ expiresAt: NOW + 12 * 3_600_000 }, 24, NOW)).toBe(true)
    expect(isTokenStale({ expiresAt: NOW - 1 }, 24, NOW)).toBe(true)
  })
})

describe('keepalive cycle', () => {
  const NOW = 1_700_000_000_000
  it('missing refresh token marks needs_relogin', async () => {
    const updates: WbAccount[] = []
    const result = await runKeepaliveCycle(
      [{ id: 'a', email: 'a@x.com', access_token: 'at', expiresAt: NOW + 3_600_000 }],
      { keepaliveDays: 0 },
      (updated) => updates.push(updated),
      { now: () => NOW },
    )
    expect(result.checked).toBe(1)
    expect(result.refreshed[0] as KeepaliveRow).toMatchObject({ email: 'a@x.com', status: 'missing_rt' })
    expect(updates[0]!['needs_relogin']).toBe(true)
  })
  it('unconditional refresh when keepaliveDays is 0', async () => {
    const http = async (_url: string, _method: 'GET' | 'POST', _body?: unknown, headers?: Record<string, string>) => {
      expect(headers?.['X-Auth-Refresh-Source']).toBe('plugin')
      return { code: 0, data: { accessToken: 'at2', expiresIn: 3600 } }
    }
    const updates: WbAccount[] = []
    const result = await runKeepaliveCycle(
      [{ id: 'a', email: 'a@x.com', access_token: 'at', refresh_token: 'rt', expiresAt: NOW + 400 * 3_600_000 }],
      { keepaliveDays: 0 },
      (updated) => updates.push(updated),
      { now: () => NOW, http },
    )
    expect(result.refreshed[0]?.status).toBe('ok')
    expect(updates[0]!['access_token']).toBe('at2')
    expect(updates[0]!['needs_relogin']).toBeUndefined()
    expect(updates[0]!['refreshedAt']).toBe(NOW)
  })
  it('skips accounts within the keepalive window', async () => {
    let calls = 0
    const http = async () => {
      calls++
      return { code: 0, data: { accessToken: 'x' } }
    }
    const result = await runKeepaliveCycle(
      [{ id: 'a', access_token: 'at', refresh_token: 'rt', expiresAt: NOW + 40 * 86_400_000 }],
      { keepaliveDays: 30 },
      () => {},
      { now: () => NOW, http },
    )
    expect(calls).toBe(0)
    expect(result.refreshed).toHaveLength(0)
  })
  it('failure marks needs_relogin with the code and message', async () => {
    const http = async () => ({ code: 403, message: 'forbidden' })
    const updates: WbAccount[] = []
    const result = await runKeepaliveCycle(
      [{ id: 'a', email: 'a@x.com', access_token: 'at', refresh_token: 'rt' }],
      { keepaliveDays: 0 },
      (updated) => updates.push(updated),
      { now: () => NOW, http },
    )
    expect(result.refreshed[0]?.status).toBe('failed')
    expect(updates[0]!['needs_relogin']).toBe(true)
    expect(updates[0]!['needs_relogin_reason']).toContain('403')
  })
})
