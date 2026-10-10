import { describe, expect, it } from 'vitest'
import {
  accountDisplayName,
  accountMeta,
  buildAuthHeaders,
  deleteAccountFrom,
  envelopeTokenError,
  findAccountIn,
  getStr,
  hasUnexpiredPlainToken,
  isEnvelope,
  upsertAccountIn,
  upsertCollectedAccount,
  variantOf,
  type WbAccount,
} from './account.ts'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000

const envelope = (value = 'enc'): Record<string, unknown> => ({ $wbEncrypted: 1, envelope: value })

describe('envelope helpers', () => {
  it('envelope token error only fires on envelope access token', () => {
    expect(envelopeTokenError({ access_token: envelope() })).toContain('信封')
    expect(envelopeTokenError({ access_token: 'plain' })).toBeUndefined()
    expect(envelopeTokenError({})).toBeUndefined()
  })
  it('isEnvelope requires the $wbEncrypted key', () => {
    expect(isEnvelope({ access_token: envelope() }, 'access_token')).toBe(true)
    expect(isEnvelope({ access_token: 'plain' }, 'access_token')).toBe(false)
    expect(isEnvelope({ access_token: { other: 1 } }, 'access_token')).toBe(false)
  })
  it('hasUnexpiredPlainToken treats missing expiry as valid', () => {
    expect(hasUnexpiredPlainToken({ access_token: 't' }, NOW)).toBe(true)
    expect(hasUnexpiredPlainToken({ access_token: 't', expiresAt: NOW + HOUR }, NOW)).toBe(true)
    expect(hasUnexpiredPlainToken({ access_token: 't', expiresAt: NOW - HOUR }, NOW)).toBe(false)
    expect(hasUnexpiredPlainToken({ access_token: envelope() }, NOW)).toBe(false)
    expect(hasUnexpiredPlainToken({ access_token: '  ' }, NOW)).toBe(false)
  })
})

describe('projection', () => {
  it('account meta strips tokens', () => {
    const meta = accountMeta({
      id: 'a1',
      access_token: 'secret',
      refresh_token: 'secret2',
      needs_relogin: true,
      needs_relogin_reason: 'expired',
      nickname: envelope('enc-nick'),
    })
    expect(meta['access_token']).toBeUndefined()
    expect(meta['refresh_token']).toBeUndefined()
    expect(meta['needsRelogin']).toBe(true)
    expect(meta['needsReloginReason']).toBe('expired')
    expect(meta['nickname']).toBeNull()
  })
  it('account meta carries variant for filtering', () => {
    expect(accountMeta({})['variant']).toBe('cn')
    expect(accountMeta({ variant: 'ai' })['variant']).toBe('ai')
    expect(accountMeta({ variant: '', domain: '' })['variant']).toBe('cn')
  })
  it('display name priority email > nickname > uid > unknown', () => {
    expect(accountDisplayName({ email: 'e', nickname: 'n', uid: 'u' })).toBe('e')
    expect(accountDisplayName({ nickname: 'n', uid: 'u' })).toBe('n')
    expect(accountDisplayName({ uid: 'u' })).toBe('u')
    expect(accountDisplayName({})).toBe('unknown')
  })
  it('getStr trims and filters empty', () => {
    expect(getStr({ k: '  v  ' }, 'k')).toBe('v')
    expect(getStr({ k: '   ' }, 'k')).toBeUndefined()
    expect(getStr({ k: 5 }, 'k')).toBeUndefined()
  })
  it('variant_of defaults to cn and reads domain fallback', () => {
    expect(variantOf({})).toBe('cn')
    expect(variantOf({ variant: 'ai' })).toBe('ai')
    expect(variantOf({ domain: 'www.workbuddy.ai' })).toBe('ai')
  })
})

describe('upsert collected (merge)', () => {
  it('same nickname with different uids is retained', () => {
    const accounts: WbAccount[] = [{ id: 'a', uid: 'u1', nickname: 'same', access_token: 't1' }]
    const saved = upsertCollectedAccount(accounts, { id: 'new', uid: 'u2', nickname: 'same', access_token: 't2' }, NOW)
    expect(accounts).toHaveLength(2)
    expect(saved['id']).toBe('new')
  })
  it('same uid refresh preserves local id and removes duplicates', () => {
    const accounts: WbAccount[] = [
      { id: 'stable', uid: 'u1', nickname: 'old', access_token: 't1' },
      { id: 'dup', uid: 'u1', nickname: 'dup', access_token: 't1b' },
    ]
    const saved = upsertCollectedAccount(accounts, { uid: 'u1', nickname: 'new', access_token: 't2' }, NOW)
    expect(accounts).toHaveLength(1)
    expect(saved['id']).toBe('stable')
    expect(saved['nickname']).toBe('new')
    expect(saved['access_token']).toBe('t2')
  })
  it('different uids with same real email are retained', () => {
    const accounts: WbAccount[] = [{ id: 'a', uid: 'u1', email: 'a@x.com' }]
    upsertCollectedAccount(accounts, { uid: 'u2', email: 'A@X.com' }, NOW)
    expect(accounts).toHaveLength(2)
  })
  it('real email is fallback only when collected uid is missing', () => {
    const accounts: WbAccount[] = [{ id: 'local', uid: 'u1', email: 'a@x.com' }]
    const saved = upsertCollectedAccount(accounts, { email: 'A@X.com', access_token: 't' }, NOW)
    expect(accounts).toHaveLength(1)
    expect(saved['id']).toBe('local')
  })
  it('legacy synthetic email does not merge accounts', () => {
    const accounts: WbAccount[] = [{ id: 'a', uid: 'u1', nickname: 'nick', email: 'nick' }]
    upsertCollectedAccount(accounts, { nickname: 'nick', email: 'nick' }, NOW)
    expect(accounts).toHaveLength(2)
  })
  it('envelope reimport keeps unexpired plain oauth token', () => {
    const accounts: WbAccount[] = [
      {
        id: 'a',
        uid: 'u1',
        access_token: 'plain',
        refresh_token: 'rplain',
        nickname: 'nick',
        expiresAt: NOW + HOUR,
      },
    ]
    const saved = upsertCollectedAccount(
      accounts,
      { uid: 'u1', access_token: envelope(), refresh_token: envelope(), nickname: envelope() },
      NOW,
    )
    expect(accounts).toHaveLength(1)
    expect(saved['access_token']).toBe('plain')
    expect(saved['refresh_token']).toBe('rplain')
    expect(saved['nickname']).toBe('nick')
  })
  it('protected envelope reimport repairs missing local id without changing tokens', () => {
    const accounts: WbAccount[] = [{ uid: 'u1', access_token: 'plain', expiresAt: NOW + HOUR }]
    const saved = upsertCollectedAccount(accounts, { id: 'collected-id', uid: 'u1', access_token: envelope() }, NOW)
    expect(typeof saved['id']).toBe('string')
    expect((saved['id'] as string).length).toBeGreaterThan(0)
    expect(saved['access_token']).toBe('plain')
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!['id']).toBe(saved['id'])
  })
  it('envelope reimport takes over after plain token expired', () => {
    const accounts: WbAccount[] = [{ id: 'a', uid: 'u1', access_token: 'plain', expiresAt: NOW - HOUR }]
    const saved = upsertCollectedAccount(accounts, { uid: 'u1', access_token: envelope() }, NOW)
    expect(typeof saved['access_token']).toBe('object')
    expect(isEnvelope(saved, 'access_token')).toBe(true)
  })
  it('fresh plain oauth token replaces envelope record', () => {
    const accounts: WbAccount[] = [{ id: 'a', uid: 'u1', access_token: envelope() }]
    const saved = upsertCollectedAccount(accounts, { uid: 'u1', access_token: 'fresh' }, NOW)
    expect(saved['access_token']).toBe('fresh')
  })
  it('upsert accepts caller supplied variant for new account', () => {
    const accounts: WbAccount[] = []
    const saved = upsertCollectedAccount(accounts, { uid: 'u1', variant: 'ai' }, NOW)
    expect(saved['variant']).toBe('ai')
  })
  it('collected account without identity gets generated id', () => {
    const accounts: WbAccount[] = []
    const saved = upsertCollectedAccount(accounts, { access_token: 't' }, NOW)
    expect(typeof saved['id']).toBe('string')
    expect((saved['id'] as string).length).toBeGreaterThan(0)
  })
  it('upsert keeps variant of recollected account', () => {
    const accounts: WbAccount[] = [{ id: 'a', uid: 'u1', variant: 'ai' }]
    const saved = upsertCollectedAccount(accounts, { uid: 'u1', access_token: 't' }, NOW)
    expect(saved['variant']).toBe('ai')
  })
})

describe('upsert account (overwrite path)', () => {
  it('keeps existing variant when updated lacks it', () => {
    const accounts: WbAccount[] = [{ id: 'a', uid: 'u1', variant: 'ai' }]
    const updated = upsertAccountIn(accounts, { id: 'a', access_token: 't' })
    expect(updated['variant']).toBe('ai')
    const appended = upsertAccountIn([], { access_token: 't', variant: 'cn' })
    expect(appended['variant']).toBe('cn')
  })
  it('without id falls back to uid and keeps store size', () => {
    const accounts: WbAccount[] = [{ id: 'local-id', uid: 'u1', variant: 'ai', access_token: 'old' }]
    const updated = upsertAccountIn(accounts, { uid: 'u1', access_token: 'new' })
    expect(accounts).toHaveLength(1)
    expect(updated['id']).toBe('local-id')
    expect(updated['variant']).toBe('ai')
  })
  it('uid fallback keeps local id when updated has a different id', () => {
    const accounts: WbAccount[] = [{ id: 'local-id', uid: 'u1' }]
    const updated = upsertAccountIn(accounts, { id: 'foreign-id', uid: 'u1' })
    expect(updated['id']).toBe('local-id')
  })
  it('uid fallback repairs empty local id', () => {
    const accounts: WbAccount[] = [{ id: '  ', uid: 'u1' }]
    const updated = upsertAccountIn(accounts, { uid: 'u1', access_token: 't' })
    expect(typeof updated['id']).toBe('string')
    expect((updated['id'] as string).length).toBeGreaterThan(0)
  })
  it('without id or uid appends once with generated id', () => {
    const accounts: WbAccount[] = []
    const first = upsertAccountIn(accounts, { access_token: 't1' })
    const second = upsertAccountIn(accounts, { id: first['id'], access_token: 't2' })
    expect(accounts).toHaveLength(1)
    expect(second['access_token']).toBe('t2')
  })
  it('repeated refresh upsert of id-less record does not grow store', () => {
    const accounts: WbAccount[] = [{ id: 'x', uid: 'u1', access_token: 't0' }]
    for (const token of ['t1', 't2', 't3', 't4']) {
      upsertAccountIn(accounts, { uid: 'u1', access_token: token })
    }
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!['access_token']).toBe('t4')
  })
})

describe('find / delete', () => {
  it('persisted same-name accounts can be found and deleted independently', () => {
    const accounts: WbAccount[] = [
      { id: 'a', uid: 'u1', nickname: 'same' },
      { id: 'b', uid: 'u2', nickname: 'same' },
    ]
    expect(findAccountIn(accounts, 'a')?.['id']).toBe('a')
    expect(findAccountIn(accounts, 'u2')?.['id']).toBe('b')
    expect(deleteAccountFrom(accounts, 'a')).toBe(true)
    expect(deleteAccountFrom(accounts, 'a')).toBe(false)
    expect(deleteAccountFrom(accounts, 'b')).toBe(true)
    expect(accounts).toHaveLength(0)
  })
})

describe('auth headers', () => {
  it('builds wbs-compatible headers', () => {
    const headers = buildAuthHeaders({
      access_token: 'tok',
      uid: 'u1',
      enterpriseId: 'e1',
      domain: 'www.codebuddy.cn',
    })
    expect(headers['Authorization']).toBe('Bearer tok')
    expect(headers['X-User-Id']).toBe('u1')
    expect(headers['X-Enterprise-Id']).toBe('e1')
    expect(headers['X-Tenant-Id']).toBe('e1')
    expect(headers['X-Domain']).toBe('www.codebuddy.cn')
    expect(headers['Accept']).toBe('application/json')
    const minimal = buildAuthHeaders({ access_token: 'tok' })
    expect(Object.keys(minimal)).toEqual(['Authorization', 'Accept', 'Content-Type'])
  })
})
