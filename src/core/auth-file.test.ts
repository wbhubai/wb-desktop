import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { importedAccountFromRoot, buildAuthObj, backupAuthFile, readAuthFile, writeAccountToAuthFile, authFilePath } from './auth-file.ts'
import { isEnvelope } from './account.ts'
import { authFileName } from './variant.ts'

const tmpRoot = async (): Promise<string> => await mkdtemp(path.join(os.tmpdir(), 'wb-auth-'))

describe('import from auth file root', () => {
  it('extracts fields (parse_ts keeps raw numeric strings — no s/ms conversion)', () => {
    const account = importedAccountFromRoot(
      {
        account: { uid: 'u1', nickname: 'nick' },
        auth: { accessToken: 'tok', expiresAt: '1791912333558' },
      },
      'cn',
    )
    expect(account).toBeDefined()
    expect(account!['uid']).toBe('u1')
    expect(account!['access_token']).toBe('tok')
    expect(account!['expiresAt']).toBe(1_791_912_333_558)
    const second = importedAccountFromRoot(
      { account: { uid: 'u1' }, auth: { accessToken: 'tok', expiresAt: '1786728333' } },
      'cn',
    )
    expect(second!['expiresAt']).toBe(1_786_728_333)
  })
  it('refresh token may be absent', () => {
    const account = importedAccountFromRoot(
      { account: { uid: 'u1' }, auth: { accessToken: 'tok' } },
      'cn',
    )
    expect(account!['refresh_token']).toBeNull()
  })
  it('without email does not synthesize one', () => {
    const account = importedAccountFromRoot(
      { account: { uid: 'u1', nickname: 'nick' }, auth: { accessToken: 'tok' } },
      'cn',
    )
    expect(account!['email']).toBeNull()
    expect(account!['variant']).toBe('cn')
  })
  it('blank access token is not imported; envelope imports verbatim', () => {
    for (const blank of ['', '   ', '\t\n']) {
      expect(importedAccountFromRoot({ auth: { accessToken: blank } }, 'cn')).toBeUndefined()
    }
    const envelopeAccount = importedAccountFromRoot(
      { auth: { accessToken: { $wbEncrypted: 1, envelope: 'enc' } } },
      'cn',
    )
    expect(envelopeAccount).toBeDefined()
    expect(isEnvelope(envelopeAccount!, 'access_token')).toBe(true)
  })
  it('imported account records source variant', () => {
    const account = importedAccountFromRoot(
      { auth: { accessToken: 'tok' } },
      'ai',
    )
    expect(account!['variant']).toBe('ai')
  })
})

describe('write', () => {
  it('writes four segments, merges allAccounts, verifies, and preserves envelopes', async () => {
    const home = await tmpRoot()
    const target = authFilePath('cn', home, 'windows')
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(
      target,
      JSON.stringify({
        account: { uid: 'old', nickname: 'old' },
        auth: { accessToken: 'old' },
        allAccounts: [{ uid: 'other', nickname: 'keep' }],
      }),
    )
    const written = await writeAccountToAuthFile(
      // expiresAt 用 now+1h 动态构造：写死绝对时间戳会随时间腐烂（过期后 expiresIn 被钳为 0）
      { uid: 'old', nickname: 'new', access_token: 'newtok', refresh_token: { $wbEncrypted: true, envelope: 'e' }, expiresAt: Date.now() + 3_600_000 },
      'cn',
      { home },
    )
    expect(written).toBe(target)
    const root = JSON.parse(await readFile(target, 'utf8'))
    expect(Object.keys(root).sort()).toEqual(['account', 'accounts', 'allAccounts', 'auth'])
    expect(root['account']['uid']).toBe('old')
    expect(root['auth']['accessToken']).toBe('newtok')
    expect(root['auth']['refreshToken']).toEqual({ $wbEncrypted: true, envelope: 'e' })
    expect(root['allAccounts']).toHaveLength(2)
    expect(root['allAccounts'].map((entry: { uid: string }) => entry.uid)).toEqual(['other', 'old'])
    expect(root['accounts']).toEqual(root['allAccounts'])
    expect(root['auth']['expiresIn']).toBeGreaterThan(0)
    await rm(home, { recursive: true, force: true })
  })
  it('buildAuthObj defaults tokenType and scope', () => {
    const auth = buildAuthObj({ access_token: 't' })
    expect(auth['tokenType']).toBe('Bearer')
    expect(auth['scope']).toBe('openid profile offline_access email')
    expect(auth['expiresIn']).toBe(0)
    expect(auth['notBeforePolicy']).toBe(0)
  })
  it('blank secret values are written as empty strings, not omitted', () => {
    const auth = buildAuthObj({})
    expect(auth['accessToken']).toBe('')
  })
})

describe('backup', () => {
  it('copies the auth file with a distinguishable name', async () => {
    const home = await tmpRoot()
    const target = authFilePath('ai', home, 'windows')
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, '{"auth":{"accessToken":"x"}}')
    const backupDir = path.join(home, 'backups')
    const backup = await backupAuthFile('ai', backupDir, home)
    expect(backup).toBeDefined()
    expect(path.basename(backup!)).toBe(`workbuddy-desktop-ai.${path.basename(backup!).split('.')[1]}.info`)
    expect(existsSync(backup!)).toBe(true)
    expect(authFileName('ai')).toBe('workbuddy-desktop-ai.info')
    const root = await readAuthFile('ai', home)
    expect(root?.['auth']).toEqual({ accessToken: 'x' })
    await rm(home, { recursive: true, force: true })
  })
})
