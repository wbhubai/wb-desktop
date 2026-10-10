/**
 * Port of wbs `modules/codebuddy_cli.rs` live-session gate: a CLI session is
 * live iff `~/.codebuddy/sessions/<pid>.json` (or `manual-*.json`) carries a
 * `lastHeartbeat` within 120s (future heartbeats count as live).
 */
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isPlainObject } from './util.ts'

export const LIVE_SESSION_STALE_MS = 120_000

export function cliSessionsDir(home = os.homedir()): string {
  return path.join(home, '.codebuddy', 'sessions')
}

/** Pure: does one session file's content represent a live heartbeat? */
export function sessionFileIsLive(content: string, nowMs: number): boolean {
  try {
    const parsed = JSON.parse(content) as unknown
    if (!isPlainObject(parsed)) return false
    const heartbeat = parsed['lastHeartbeat']
    if (typeof heartbeat !== 'number' || !Number.isFinite(heartbeat)) return false
    return nowMs - heartbeat <= LIVE_SESSION_STALE_MS
  } catch {
    return false
  }
}

export function sessionFileNameCounts(name: string): boolean {
  return /^\d+\.json$/.test(name) || /^manual-.*\.json$/.test(name)
}

export async function hasLiveCliSessionIn(dir: string, nowMs = Date.now()): Promise<boolean> {
  if (!existsSync(dir)) return false
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return false
  }
  for (const name of names) {
    if (!sessionFileNameCounts(name)) continue
    try {
      const content = await readFile(path.join(dir, name), 'utf8')
      if (sessionFileIsLive(content, nowMs)) return true
    } catch {
      continue
    }
  }
  return false
}

export async function hasLiveCliSession(nowMs = Date.now()): Promise<boolean> {
  return await hasLiveCliSessionIn(cliSessionsDir(), nowMs)
}
