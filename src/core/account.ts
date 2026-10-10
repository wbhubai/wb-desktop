/**
 * Port of wbs `modules/account.rs` — the account library record model, merge
 * rules, envelope (WorkBuddy 5.6 `{$wbEncrypted, envelope}`) protection and
 * auth-header construction. Records are dynamic JSON objects; field names ARE
 * the model, exactly like the Rust original.
 */
import { variantFromAccount, type WbVariant } from './variant.ts'
import { isPlainObject, nowMs, normTs } from './util.ts'

export type WbAccount = Record<string, unknown>

// ------------------------------------------------------------------ strings

/** Trimmed non-empty string, else undefined. */
export function getStr(record: WbAccount, key: string): string | undefined {
  const value = record[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

export function accountDisplayName(account: WbAccount): string {
  return getStr(account, 'email') ?? getStr(account, 'nickname') ?? getStr(account, 'uid') ?? 'unknown'
}

export function variantOf(account: WbAccount): WbVariant {
  return variantFromAccount(account)
}

// ---------------------------------------------------------------- envelope

/** `{$wbEncrypted: <any>, envelope: "<ciphertext>"}` — decrypted by WorkBuddy itself. */
export function isEnvelope(record: WbAccount, key: string): boolean {
  const value = record[key]
  return isPlainObject(value) && '$wbEncrypted' in value
}

/**
 * Non-blank trimmed string OR verbatim envelope object; anything else (incl.
 * blank strings) is absent.
 */
export function secretValue(record: WbAccount, key: string): string | Record<string, unknown> | undefined {
  const value = record[key]
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  if (isPlainObject(value) && '$wbEncrypted' in value) return value
  return undefined
}

/** Scalars pass through; envelopes become null (display projection). */
export function displayValue(record: WbAccount, key: string): unknown {
  const value = record[key]
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return null
}

/** Plain (non-envelope) access token that is unexpired or expiry-less. */
export function hasUnexpiredPlainToken(account: WbAccount, at = nowMs()): boolean {
  const token = account['access_token']
  if (typeof token !== 'string' || token.trim() === '') return false
  const expiresAt = normTs(account['expiresAt'])
  return expiresAt === null || expiresAt > at
}

export const ENVELOPE_TOKEN_ERROR =
  '该账号凭据为 WorkBuddy 加密信封态，无法直接调用签到 / 积分 / Token 统计等接口；切换功能不受影响，如需上述功能请删除该账号后改用「OAuth 扫码添加」获取明文凭据。'

export function envelopeTokenError(account: WbAccount): string | undefined {
  return isEnvelope(account, 'access_token') ? ENVELOPE_TOKEN_ERROR : undefined
}

// ---------------------------------------------------------------- headers

export function buildAuthHeaders(account: WbAccount): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${typeof account['access_token'] === 'string' ? account['access_token'] : ''}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  const uid = getStr(account, 'uid')
  if (uid) headers['X-User-Id'] = uid
  const enterpriseId = getStr(account, 'enterpriseId') ?? getStr(account, 'enterprise_id')
  if (enterpriseId) {
    headers['X-Enterprise-Id'] = enterpriseId
    headers['X-Tenant-Id'] = enterpriseId
  }
  const domain = getStr(account, 'domain')
  if (domain) headers['X-Domain'] = domain
  return headers
}

// ---------------------------------------------------------------- identity

function identityEmail(account: WbAccount): string | undefined {
  const email = getStr(account, 'email')
  if (!email || !email.includes('@')) return undefined
  const lowered = email.toLowerCase()
  if (lowered === 'unknown' || lowered === '手动添加') return undefined
  const nickname = getStr(account, 'nickname')
  const uid = getStr(account, 'uid')
  if (nickname && lowered === nickname.toLowerCase()) return undefined
  if (uid && lowered === uid.toLowerCase()) return undefined
  return lowered
}

function matchingIdentityIndexes(accounts: WbAccount[], collected: WbAccount): number[] {
  const collectedUid = getStr(collected, 'uid')
  if (collectedUid) {
    return accounts.flatMap((account, index) => (getStr(account, 'uid') === collectedUid ? [index] : []))
  }
  const email = identityEmail(collected)
  if (!email) return []
  return accounts.flatMap((account, index) => {
    const existing = identityEmail(account)
    return existing === email ? [index] : []
  })
}

function inheritExistingVariant(existing: WbAccount, collected: WbAccount): void {
  const variant = getStr(collected, 'variant')
  if (variant) return
  const existingVariant = getStr(existing, 'variant')
  if (existingVariant) collected['variant'] = existingVariant
}

function newId(): string {
  return crypto.randomUUID()
}

/**
 * Merge a collected account into the store (upsert by uid, else fallback
 * email). Envelope protection: an envelope never overwrites unexpired
 * plaintext — the whole record short-circuits to the existing one.
 */
export function upsertCollectedAccount(accounts: WbAccount[], collected: WbAccount, at = nowMs()): WbAccount {
  const matches = matchingIdentityIndexes(accounts, collected)
  const first = matches[0]
  if (first !== undefined) {
    const existing = accounts[first]!
    if (isEnvelope(collected, 'access_token') && hasUnexpiredPlainToken(existing, at)) {
      if (getStr(existing, 'id')) return existing
      const repaired = { ...existing }
      repaired['id'] = getStr(collected, 'id') ?? newId()
      accounts[first] = repaired
      return repaired
    }
    for (const key of ['nickname', 'email', 'enterpriseName'] as const) {
      if (isEnvelope(collected, key)) collected[key] = existing[key]
    }
    collected['id'] = getStr(existing, 'id') ?? getStr(collected, 'id') ?? newId()
    if (!getStr(collected, 'uid')) collected['uid'] = existing['uid'] ?? null
    collected['createdAt'] = existing['createdAt'] ?? collected['createdAt'] ?? nowMs()
    inheritExistingVariant(existing, collected)
    for (const index of [...matches].reverse()) accounts.splice(index, 1)
    accounts.splice(Math.min(first, accounts.length), 0, collected)
    return collected
  }
  if (!getStr(collected, 'id')) collected['id'] = newId()
  accounts.push(collected)
  return collected
}

/**
 * Overwrite path (used by refresh/import): match by id first, else uid; never
 * lose the stored variant; uid-fallback keeps the LOCAL id.
 */
export function upsertAccountIn(accounts: WbAccount[], updated: WbAccount): WbAccount {
  const id = getStr(updated, 'id')
  let index = id === undefined ? -1 : accounts.findIndex((account) => getStr(account, 'id') === id)
  if (index < 0) {
    const uid = getStr(updated, 'uid')
    index = uid === undefined ? -1 : accounts.findIndex((account) => getStr(account, 'uid') === uid)
    if (index >= 0) {
      // uid fallback keeps the LOCAL id even when updated carries a different one
      updated['id'] = accounts[index]!['id']
    }
  }
  if (index >= 0) {
    const existing = accounts[index]!
    inheritExistingVariant(existing, updated)
    if (!getStr(updated, 'id')) updated['id'] = newId()
    accounts[index] = updated
    return updated
  }
  if (!getStr(updated, 'id')) updated['id'] = newId()
  accounts.push(updated)
  return updated
}

export function findAccountIn(accounts: WbAccount[], accountId: string): WbAccount | undefined {
  return accounts.find((account) => getStr(account, 'id') === accountId || getStr(account, 'uid') === accountId)
}

export function deleteAccountFrom(accounts: WbAccount[], accountId: string): boolean {
  const index = accounts.findIndex((account) => getStr(account, 'id') === accountId)
  if (index < 0) return false
  accounts.splice(index, 1)
  return true
}

// ------------------------------------------------------------- projection

/** Display projection: strips tokens, carries needsRelogin + variant. */
export function accountMeta(account: WbAccount): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    id: displayValue(account, 'id'),
    uid: displayValue(account, 'uid'),
    email: displayValue(account, 'email'),
    nickname: displayValue(account, 'nickname'),
    enterpriseName: displayValue(account, 'enterpriseName'),
    expiresAt: displayValue(account, 'expiresAt'),
    refreshExpiresAt: displayValue(account, 'refreshExpiresAt'),
    refreshedAt: displayValue(account, 'refreshedAt'),
    createdAt: displayValue(account, 'createdAt'),
    needsRelogin: account['needs_relogin'] === true,
    needsReloginReason: displayValue(account, 'needs_relogin_reason'),
    variant: variantOf(account),
  }
  return meta
}
