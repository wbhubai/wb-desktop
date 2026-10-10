/**
 * Port of wbs `modules/error_log.rs` — JSONL error ring (200 lines) with kind
 * whitelist and 4096-byte detail truncation. Content is pre-sanitized by the
 * caller (hubCore.sanitize), never contains tokens.
 */
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

export const ERROR_LOG_MAX_LINES = 200
export const ERROR_LOG_DETAIL_MAX_BYTES = 4096

export interface ErrorLogEntry {
  ts: number
  kind: 'backend' | 'frontend_crash' | 'frontend_unhandled'
  message: string
  detail: string
  appVersion: string
  os: string
}

export function normalizeKind(kind: string): ErrorLogEntry['kind'] {
  return kind === 'frontend_crash' || kind === 'frontend_unhandled' ? kind : 'backend'
}

/** Byte-cap at a UTF-8 boundary (no half multibyte chars). */
export function truncateDetail(detail: string, max = ERROR_LOG_DETAIL_MAX_BYTES): string {
  const buffer = Buffer.from(detail, 'utf8')
  if (buffer.length <= max) return detail
  let cut = max
  while (cut > 0 && (buffer[cut]! & 0xc0) === 0x80) cut -= 1
  return buffer.subarray(0, cut).toString('utf8')
}

export function buildEntry(kind: string, message: string, detail: string, at: number, appVersion: string, os: string): ErrorLogEntry {
  return {
    ts: at,
    kind: normalizeKind(kind),
    message,
    detail: truncateDetail(detail),
    appVersion,
    os,
  }
}

export async function recordAt(file: string, entry: ErrorLogEntry): Promise<void> {
  const lines: ErrorLogEntry[] = []
  if (existsSync(file)) {
    const text = await readFile(file, 'utf8').catch(() => '')
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        lines.push(JSON.parse(line) as ErrorLogEntry)
      } catch {
        // unparseable lines are dropped
      }
    }
  }
  lines.push(entry)
  const kept = lines.length > ERROR_LOG_MAX_LINES ? lines.slice(lines.length - ERROR_LOG_MAX_LINES) : lines
  const content = `${kept.map((item) => JSON.stringify(item)).join('\n')}\n`
  await import('node:fs/promises').then((fs) => fs.mkdir(path.dirname(file), { recursive: true }))
  const tmp = `${file}.tmp-${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, content, 'utf8')
  try {
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

export async function listAt(file: string): Promise<ErrorLogEntry[]> {
  if (!existsSync(file)) return []
  const text = await readFile(file, 'utf8').catch(() => '')
  const out: ErrorLogEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line) as ErrorLogEntry)
    } catch {
      // skip
    }
  }
  return out.reverse()
}
