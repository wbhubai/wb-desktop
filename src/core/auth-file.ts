/**
 * Port of wbs `modules/auth_file.rs` — the official WorkBuddy auth file:
 * four-segment JSON (account/auth/accounts/allAccounts), backup, atomic write
 * with post-write verification, envelope write-back verbatim (never
 * decrypted, never blanked), and field extraction for local import.
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getStr, isEnvelope, secretValue, type WbAccount } from './account.ts'
import { isPlainObject, nowMs, utcIso } from './util.ts'
import {
  authFilePathAt,
  backupFileName,
  currentHostOs,
  type HostOs,
  type WbVariant,
} from './variant.ts'

/** parse_ts for auth files: numbers kept as-is, numeric strings via f64 — NO s/ms conversion. */
export function parseTs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return null
}

function firstStr(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/** secret_value chain: plain string OR envelope object, else absent. */
function firstSecret(...values: unknown[]): string | Record<string, unknown> | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed !== '') return trimmed
    } else if (isPlainObject(value) && '$wbEncrypted' in value) {
      return value
    }
  }
  return undefined
}

export function homeDir(): string {
  return os.homedir()
}

export function authFilePath(variant: WbVariant, home = homeDir(), os: HostOs = currentHostOs()): string {
  return authFilePathAt(home, os, variant)
}

// ------------------------------------------------------------------ import

export function importedAccountFromRoot(root: Record<string, unknown>, variant: WbVariant, at = nowMs()): WbAccount | undefined {
  const accountObj = isPlainObject(root['account']) ? root['account'] : {}
  const authObj = isPlainObject(root['auth']) ? root['auth'] : {}

  const uid = firstStr(root['uid'], accountObj['uid'], accountObj['id']) ?? null
  const nickname =
    firstSecret(root['nickname'], root['name'], accountObj['nickname'], accountObj['label']) ?? null
  const email = firstStr(root['email'], accountObj['email'], authObj['email']) ?? null
  const accessToken =
    firstSecret(authObj['accessToken'], authObj['access_token'], root['accessToken'], root['access_token'])
  if (accessToken === undefined) return undefined
  const refreshToken = firstSecret(
    authObj['refreshToken'],
    authObj['refresh_token'],
    root['refreshToken'],
    root['refresh_token'],
  )
  const tokenType = firstStr(authObj['tokenType'], authObj['token_type']) ?? 'Bearer'
  const domain = firstStr(root['domain'], authObj['domain']) ?? null
  const expiresAt = parseTs(firstStr(root['expiresAt'], authObj['expiresAt']))
  const refreshExpiresAt = parseTs(firstStr(root['refreshExpiresAt'], authObj['refreshExpiresAt']))
  const enterpriseName = firstStr(root['enterpriseName'], root['enterprise_name'], accountObj['enterpriseName'], accountObj['enterprise_name']) ?? null
  const enterpriseId = firstStr(root['enterpriseId'], root['enterprise_id'], accountObj['enterpriseId'], accountObj['enterprise_id']) ?? null

  return {
    id: crypto.randomUUID(),
    uid,
    nickname,
    email,
    variant,
    enterpriseName,
    enterpriseId,
    access_token: accessToken,
    refresh_token: refreshToken ?? null,
    token_type: tokenType,
    domain,
    expiresAt: expiresAt ?? null,
    refreshExpiresAt: refreshExpiresAt ?? null,
    auth_raw: root,
    profile_raw: accountObj,
    createdAt: at,
  }
}

export async function importFromAuthFile(variant: WbVariant, home = homeDir()): Promise<WbAccount | undefined> {
  const root = await readAuthFile(variant, home)
  if (!root) return undefined
  return importedAccountFromRoot(root, variant)
}

// ------------------------------------------------------------------- write

const DEFAULTS_ACCOUNT: Record<string, unknown> = {
  type: 'personal',
  accountType: '',
  idp: '',
  oneidAccountId: '',
  areaInfoComplete: false,
  isCurrentOneIdEnterprise: false,
  isCurrentOneIdPersonal: false,
  isFirstLogin: false,
  isCreator: false,
  isAdmin: false,
  uin: '',
  phoneNumber: '',
  lastLogin: true,
  pluginEnabled: true,
  deployStatus: { statusCode: 0, statusMsg: '', detailMsg: '' },
  sso: { domain: '', domainModifiedTimes: 0 },
}

function setDefault(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (!(key in obj)) obj[key] = value
}

export function buildAccountObj(account: WbAccount): Record<string, unknown> {
  const base = isPlainObject(account['profile_raw']) ? { ...(account['profile_raw'] as Record<string, unknown>) } : {}
  base['uid'] = getStr(account, 'uid') ?? ''
  base['nickname'] = secretValue(account, 'nickname') ?? ''
  for (const [key, value] of Object.entries(DEFAULTS_ACCOUNT)) setDefault(base, key, value)
  return base
}

export function buildAuthObj(account: WbAccount, at = nowMs()): Record<string, unknown> {
  const authRaw = account['auth_raw']
  let base: Record<string, unknown> = {}
  if (isPlainObject(authRaw)) {
    base = isPlainObject(authRaw['auth']) ? { ...authRaw['auth'] } : { ...authRaw }
  }
  // envelope written back verbatim — never decrypted, never blanked
  base['accessToken'] = secretValue(account, 'access_token') ?? ''
  base['refreshToken'] = secretValue(account, 'refresh_token') ?? ''
  base['tokenType'] = getStr(account, 'token_type') ?? 'Bearer'
  base['domain'] = getStr(account, 'domain') ?? ''
  base['lastRefreshTime'] = at
  setDefault(base, 'scope', 'openid profile offline_access email')
  const expiresAt = typeof account['expiresAt'] === 'number' ? account['expiresAt'] : null
  if (expiresAt !== null) {
    base['expiresAt'] = expiresAt
    base['expiresIn'] = Math.max(0, Math.floor((expiresAt - at) / 1000))
    const refreshExpiresAt =
      (isPlainObject(authRaw) ? parseTs(authRaw['refreshExpiresAt']) : null) ??
      (typeof account['refreshExpiresAt'] === 'number' ? account['refreshExpiresAt'] : null) ??
      expiresAt
    base['refreshExpiresAt'] = refreshExpiresAt
    base['refreshExpiresIn'] = Math.max(0, Math.floor((refreshExpiresAt - at) / 1000))
  } else {
    setDefault(base, 'expiresIn', 0)
    setDefault(base, 'refreshExpiresIn', 0)
  }
  setDefault(base, 'notBeforePolicy', 0)
  setDefault(base, 'sessionState', '')
  return base
}

function identityOf(account: Record<string, unknown>): string {
  return getStr(account, 'uid') ?? getStr(account, 'id') ?? ''
}

export async function readAuthFile(variant: WbVariant, home = homeDir(), os: HostOs = currentHostOs()): Promise<Record<string, unknown> | undefined> {
  const file = authFilePath(variant, home, os)
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export async function backupAuthFile(
  variant: WbVariant,
  backupDir: string,
  home = homeDir(),
  os: HostOs = currentHostOs(),
): Promise<string | undefined> {
  const file = authFilePath(variant, home, os)
  if (!existsSync(file)) return undefined
  await mkdir(backupDir, { recursive: true })
  const dest = path.join(backupDir, backupFileName(variant, utcIso()))
  await copyFile(file, dest)
  return dest
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${crypto.randomUUID()}`)
  await writeFile(tmp, content, 'utf8')
  try {
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** Merge target into allAccounts by identity, write 4 segments, verify. */
export async function writeAccountToAuthFile(
  account: WbAccount,
  variant: WbVariant,
  options: { home?: string; os?: HostOs; now?: () => number } = {},
): Promise<string> {
  const home = options.home ?? homeDir()
  const os = options.os ?? currentHostOs()
  const at = options.now?.() ?? nowMs()
  const file = authFilePath(variant, home, os)
  const existing = (await readAuthFile(variant, home, os)) ?? {}
  const list = Array.isArray(existing['allAccounts'])
    ? [...(existing['allAccounts'] as Record<string, unknown>[])]
    : Array.isArray(existing['accounts'])
      ? [...(existing['accounts'] as Record<string, unknown>[])]
      : []
  const accountObj = buildAccountObj(account)
  const authObj = buildAuthObj(account, at)
  const targetIdentity = identityOf(accountObj)
  const merged = list.filter((entry) => isPlainObject(entry) && identityOf(entry) !== targetIdentity)
  merged.push(accountObj)
  const session = {
    account: accountObj,
    auth: authObj,
    accounts: merged,
    allAccounts: merged,
  }
  await atomicWrite(file, `${JSON.stringify(session, null, 2)}\n`)
  // post-write verification: accessToken must match by value (string or envelope)
  const written = await readAuthFile(variant, home, os)
  const writtenToken = written && isPlainObject(written['auth']) ? written['auth']['accessToken'] : undefined
  if (JSON.stringify(writtenToken) !== JSON.stringify(authObj['accessToken'])) {
    throw new Error('认证文件写后校验失败，未写入目标账号')
  }
  return file
}
