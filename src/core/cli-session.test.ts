import { describe, expect, it } from 'vitest'
import { hasLiveCliSessionIn, sessionFileNameCounts, sessionFileIsLive, LIVE_SESSION_STALE_MS } from './cli-session.ts'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const NOW = 1_700_000_000_000

describe('cli live-session gate', () => {
  it('only pid.json and manual-*.json count', () => {
    expect(sessionFileNameCounts('1234.json')).toBe(true)
    expect(sessionFileNameCounts('manual-run.json')).toBe(true)
    expect(sessionFileNameCounts('notes.json')).toBe(false)
    expect(sessionFileNameCounts('abc.json')).toBe(false)
    expect(sessionFileNameCounts('1234.txt')).toBe(false)
  })
  it('heartbeat within the window is live; future is live; missing/absent is not', () => {
    expect(sessionFileIsLive(JSON.stringify({ lastHeartbeat: NOW - LIVE_SESSION_STALE_MS }), NOW)).toBe(true)
    expect(sessionFileIsLive(JSON.stringify({ lastHeartbeat: NOW - LIVE_SESSION_STALE_MS - 1 }), NOW)).toBe(false)
    expect(sessionFileIsLive(JSON.stringify({ lastHeartbeat: NOW + 60_000 }), NOW)).toBe(true)
    expect(sessionFileIsLive(JSON.stringify({}), NOW)).toBe(false)
    expect(sessionFileIsLive('not json', NOW)).toBe(false)
  })
  it('scans the directory and tolerates missing roots', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wb-cli-'))
    await writeFile(path.join(dir, '111.json'), JSON.stringify({ lastHeartbeat: NOW }))
    expect(await hasLiveCliSessionIn(dir, NOW)).toBe(true)
    await writeFile(path.join(dir, '222.json'), JSON.stringify({ lastHeartbeat: NOW - 500_000 }))
    expect(await hasLiveCliSessionIn(dir, NOW)).toBe(true)
    await writeFile(path.join(dir, '333.json'), JSON.stringify({ other: 1 }))
    await writeFile(path.join(dir, '999.txt'), 'nope')
    expect(await hasLiveCliSessionIn(dir, NOW)).toBe(true)
    expect(await hasLiveCliSessionIn(path.join(dir, 'missing'), NOW)).toBe(false)
  })
})
