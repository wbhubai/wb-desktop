import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildEntry, listAt, normalizeKind, recordAt, truncateDetail, ERROR_LOG_MAX_LINES } from './error-log.ts'

describe('error log', () => {
  it('ring keeps only the last 200 lines (listAt returns newest first)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wb-elog-'))
    const file = path.join(dir, 'error.log')
    for (let index = 1; index <= 250; index++) {
      await recordAt(file, buildEntry('backend', `m${index}`, '', index, '0.1.0', 'win32'))
    }
    const entries = await listAt(file)
    expect(entries).toHaveLength(ERROR_LOG_MAX_LINES)
    expect(entries[0]!.message).toBe('m250')
    expect(entries.at(-1)!.message).toBe('m51')
    await recordAt(file, buildEntry('backend', 'm251', '', 251, '0.1.0', 'win32'))
    const again = await listAt(file)
    expect(again).toHaveLength(ERROR_LOG_MAX_LINES)
    expect(again[0]!.message).toBe('m251')
    expect(again.at(-1)!.message).toBe('m52')
  })
  it('entry has fixed fields, normalizes kind and truncates detail', async () => {
    expect(normalizeKind('frontend_crash')).toBe('frontend_crash')
    expect(normalizeKind('whatever')).toBe('backend')
    expect(truncateDetail('x'.repeat(4096))).toHaveLength(4096)
    const truncated = truncateDetail('错'.repeat(3000))
    expect(Buffer.byteLength(truncated, 'utf8')).toBe(4095)
    const entry = buildEntry('nope', 'msg', 'd'.repeat(5000), 1, '0.1.0', 'win32')
    expect(Object.keys(entry).sort()).toEqual(['appVersion', 'detail', 'kind', 'message', 'os', 'ts'])
    expect(entry.detail).toHaveLength(4096)
  })
  it('write failure surfaces instead of panicking', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wb-elog-'))
    const blocker = path.join(dir, 'blocker')
    await writeFile(blocker, 'file')
    await expect(recordAt(path.join(blocker, 'error.log'), buildEntry('backend', 'm', '', 1, 'v', 'os'))).rejects.toThrow()
  })
  it('normalizes legacy rows on read', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wb-elog-'))
    const file = path.join(dir, 'logs', 'error.log')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '{"ts":1,"kind":"backend","message":"a","detail":"","appVersion":"v","os":"o"}\nbroken\n')
    const entries = await listAt(file)
    expect(entries).toHaveLength(1)
    expect(existsSync(file)).toBe(true)
  })
})
