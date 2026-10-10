/**
 * Port of wbs `modules/variant.rs` — WorkBuddy variant (cn / ai) domain tables.
 * Default variant is Cn; historical data needs zero migration.
 */

export type WbVariant = 'cn' | 'ai'

export const ALL_VARIANTS: readonly WbVariant[] = ['cn', 'ai']

const AI_API_ENDPOINT = 'https://www.workbuddy.ai'
const AI_OAUTH_PLATFORM = 'workbuddy-ai'
const AI_DOMAIN_SUFFIX = '.workbuddy.ai'
export const WORKBUDDY_API_ENDPOINT = 'https://www.codebuddy.cn'
export const WORKBUDDY_API_PREFIX = '/v2/plugin'
export const WORKBUDDY_PLATFORM = 'workbuddy'
export const CHECKIN_API_PREFIX = '/v2/billing/meter'

const CN_CODEBUDDY_DOMAIN = 'www.codebuddy.cn'
const AI_CODEBUDDY_DOMAIN = 'www.codebuddy.ai'
const CN_AUTH_FILE_NAME = 'workbuddy-desktop.info'
const AI_AUTH_FILE_NAME = 'workbuddy-desktop-ai.info'
const CN_DATA_ROOT = '.workbuddy'
const AI_DATA_ROOT = '.workbuddy-ai'
const CN_WINDOWS_IMAGES = ['WorkBuddy'] as const
const AI_WINDOWS_IMAGES = ['WorkBuddyAI'] as const
const CN_MACOS_APPS = ['WorkBuddy.app'] as const
const AI_MACOS_APPS = ['WorkBuddy AI.app'] as const
const CN_MACOS_BUNDLE_ID = 'com.tencent.workbuddy.mac'
const AI_MACOS_BUNDLE_ID = 'com.workbuddy.workbuddy-ai'
const CN_LINUX_APP = '/usr/bin/workbuddy'
const AI_LINUX_APP = '/usr/bin/workbuddy-ai'

export function variantParse(raw: string | null | undefined): WbVariant {
  const value = (raw ?? '').trim().toLowerCase()
  return value === 'ai' || value === 'intl' || value === 'global' ? 'ai' : 'cn'
}

/** Explicit `variant` field wins (after trim); else domain suffix `.workbuddy.ai` (suffix-only); else cn. */
export function variantFromAccount(account: Record<string, unknown> | null | undefined): WbVariant {
  const explicit = account && typeof account === 'object' ? stringField(account, 'variant').trim() : ''
  if (explicit) return variantParse(explicit)
  const domain = account && typeof account === 'object' ? stringField(account, 'domain') : ''
  return domain.toLowerCase().endsWith(AI_DOMAIN_SUFFIX) ? 'ai' : 'cn'
}

export function variantMatchesDomain(variant: WbVariant, domain: string | null | undefined): boolean {
  const value = (domain ?? '').trim()
  if (!value) return true
  const isAi = value.toLowerCase().endsWith(AI_DOMAIN_SUFFIX)
  return variant === 'ai' ? isAi : !isAi
}

export function variantApiEndpoint(variant: WbVariant): string {
  return variant === 'ai' ? AI_API_ENDPOINT : WORKBUDDY_API_ENDPOINT
}

export function variantApiPrefix(_variant: WbVariant): string {
  return WORKBUDDY_API_PREFIX
}

export function variantOauthPlatform(variant: WbVariant): string {
  return variant === 'ai' ? AI_OAUTH_PLATFORM : WORKBUDDY_PLATFORM
}

export function variantCodebuddyDomain(variant: WbVariant): string {
  return variant === 'ai' ? AI_CODEBUDDY_DOMAIN : CN_CODEBUDDY_DOMAIN
}

/**
 * Billing path candidates. Cn uses the path as-is; Ai tries `/billing/meter/...`
 * first and falls back to `/v2/billing/meter/...` — only HTTP 404 may advance.
 */
export function variantBillingPaths(variant: WbVariant, path: string): string[] {
  if (variant === 'cn') return [path]
  const primary = path.startsWith(CHECKIN_API_PREFIX)
    ? `/billing/meter${path.slice(CHECKIN_API_PREFIX.length)}`
    : path
  const fallback = `/v2${primary}`
  return fallback === primary ? [primary] : [primary, fallback]
}

export type HostOs = 'macos' | 'windows' | 'linux'

export function currentHostOs(): HostOs {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  return 'linux'
}

/** Auth file directory (shared by both variants; filenames differ). */
export function authFileDirAt(home: string, os: HostOs): string {
  switch (os) {
    case 'macos':
      return joinPath(home, 'Library/Application Support/CodeBuddyExtension/Data/Public/auth')
    case 'windows':
      return joinPath(home, 'AppData/Local/CodeBuddyExtension/Data/Public/auth')
    case 'linux':
      return joinPath(home, '.local/share/CodeBuddyExtension/Data/Public/auth')
  }
}

export function authFileName(variant: WbVariant): string {
  return variant === 'ai' ? AI_AUTH_FILE_NAME : CN_AUTH_FILE_NAME
}

export function authFilePathAt(home: string, os: HostOs, variant: WbVariant): string {
  return joinPath(authFileDirAt(home, os), authFileName(variant))
}

export function backupFileName(variant: WbVariant, ts: string): string {
  const stem = authFileName(variant).replace(/\.info$/, '')
  return `${stem}.${ts}.info`
}

export function dataRootAt(home: string, variant: WbVariant): string {
  return joinPath(home, variant === 'ai' ? AI_DATA_ROOT : CN_DATA_ROOT)
}

export function windowsImageNames(variant: WbVariant): string[] {
  return [...(variant === 'ai' ? AI_WINDOWS_IMAGES : CN_WINDOWS_IMAGES)]
}

export function windowsExeNames(variant: WbVariant): string[] {
  return windowsImageNames(variant).map((name) => `${name}.exe`)
}

export function macosAppNames(variant: WbVariant): string[] {
  return [...(variant === 'ai' ? AI_MACOS_APPS : CN_MACOS_APPS)]
}

export function macosBundleId(variant: WbVariant): string {
  return variant === 'ai' ? AI_MACOS_BUNDLE_ID : CN_MACOS_BUNDLE_ID
}

export function macosDefaultAppPath(variant: WbVariant): string {
  const name = macosAppNames(variant)[0] ?? 'WorkBuddy.app'
  return `/Applications/${name}`
}

export function linuxAppPath(variant: WbVariant): string {
  return variant === 'ai' ? AI_LINUX_APP : CN_LINUX_APP
}

export function linuxProcessPattern(variant: WbVariant): string {
  return variant === 'ai' ? 'workbuddy-ai' : 'workbuddy'
}

export const supportsTravel = (variant: WbVariant): boolean => variant === 'cn'
export const supportsCheckin = (variant: WbVariant): boolean => variant === 'cn'

/**
 * Maps WorkBuddy product domains onto the CodeBuddy SSO domain; everything
 * else (corporate / already-codebuddy) passes through unchanged.
 */
export function codebuddyDomainFor(domain: string | null | undefined, variant: WbVariant): string {
  const value = (domain ?? '').trim().toLowerCase()
  if (!value) return variantCodebuddyDomain(variant)
  if (value === 'www.workbuddy.cn' || value === 'workbuddy.cn') return CN_CODEBUDDY_DOMAIN
  if (value === 'www.workbuddy.ai' || value === 'workbuddy.ai') return AI_CODEBUDDY_DOMAIN
  return value
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function joinPath(base: string, relative: string): string {
  return `${base.replace(/[\\/]+$/, '')}/${relative}`
}
