import { describe, expect, it } from 'vitest'
import {
  authFilePathAt,
  backupFileName,
  codebuddyDomainFor,
  dataRootAt,
  linuxAppPath,
  macosAppNames,
  macosBundleId,
  macosDefaultAppPath,
  supportsCheckin,
  supportsTravel,
  variantApiEndpoint,
  variantApiPrefix,
  variantBillingPaths,
  variantFromAccount,
  variantMatchesDomain,
  variantOauthPlatform,
  variantParse,
  windowsImageNames,
  windowsExeNames,
  type WbVariant,
} from './variant.ts'

describe('variant parse', () => {
  it('is backward compatible (defaults to cn)', () => {
    for (const raw of [null, '', '   ', 'cn', ' CN ', 'unknown']) {
      expect(variantParse(raw as string | null)).toBe('cn')
    }
    for (const raw of ['ai', 'AI', 'intl', 'global']) {
      expect(variantParse(raw)).toBe('ai')
    }
  })
})

describe('variant from account', () => {
  it('prefers explicit field then domain', () => {
    expect(variantFromAccount({})).toBe('cn')
    expect(variantFromAccount({ domain: 'www.codebuddy.cn' })).toBe('cn')
    expect(variantFromAccount({ variant: 'ai' })).toBe('ai')
    expect(variantFromAccount({ variant: 'cn', domain: 'www.workbuddy.ai' })).toBe('cn')
    expect(variantFromAccount({ variant: '  ', domain: 'www.workbuddy.ai' })).toBe('ai')
    expect(variantFromAccount({ domain: 'www.workbuddy.ai.evil.com' })).toBe('cn')
  })
})

describe('variant tables', () => {
  it('network and identity differ by variant', () => {
    expect(variantApiEndpoint('cn')).toBe('https://www.codebuddy.cn')
    expect(variantApiEndpoint('ai')).toBe('https://www.workbuddy.ai')
    expect(variantApiPrefix('cn')).toBe('/v2/plugin')
    expect(variantApiPrefix('ai')).toBe('/v2/plugin')
    expect(variantOauthPlatform('cn')).toBe('workbuddy')
    expect(variantOauthPlatform('ai')).toBe('workbuddy-ai')
    expect(windowsImageNames('cn')).toEqual(['WorkBuddy'])
    expect(windowsImageNames('ai')).toEqual(['WorkBuddyAI'])
    expect(windowsExeNames('cn')).toEqual(['WorkBuddy.exe'])
    expect(windowsExeNames('ai')).toEqual(['WorkBuddyAI.exe'])
    expect(macosAppNames('cn')).toEqual(['WorkBuddy.app'])
    expect(macosAppNames('ai')).toEqual(['WorkBuddy AI.app'])
    expect(macosBundleId('cn')).toBe('com.tencent.workbuddy.mac')
    expect(macosBundleId('ai')).toBe('com.workbuddy.workbuddy-ai')
    expect(macosDefaultAppPath('cn')).toBe('/Applications/WorkBuddy.app')
    expect(linuxAppPath('cn')).toBe('/usr/bin/workbuddy')
    expect(linuxAppPath('ai')).toBe('/usr/bin/workbuddy-ai')
  })

  it('capability declarations: travel and checkin are cn-only', () => {
    expect(supportsTravel('cn')).toBe(true)
    expect(supportsTravel('ai')).toBe(false)
    expect(supportsCheckin('cn')).toBe(true)
    expect(supportsCheckin('ai')).toBe(false)
  })

  it('billing paths keep cn single and order ai fallback', () => {
    expect(variantBillingPaths('cn', '/v2/billing/meter/daily-checkin')).toEqual(['/v2/billing/meter/daily-checkin'])
    expect(variantBillingPaths('ai', '/v2/billing/meter/daily-checkin')).toEqual([
      '/billing/meter/daily-checkin',
      '/v2/billing/meter/daily-checkin',
    ])
    expect(variantBillingPaths('ai', '/other/path')).toEqual(['/other/path', '/v2/other/path'])
  })

  it('matches domain rejects cross-variant responses', () => {
    expect(variantMatchesDomain('ai', 'www.workbuddy.ai')).toBe(true)
    expect(variantMatchesDomain('ai', 'WWW.WORKBUDDY.AI')).toBe(true)
    expect(variantMatchesDomain('ai', ' www.workbuddy.ai ')).toBe(true)
    expect(variantMatchesDomain('ai', 'www.codebuddy.cn')).toBe(false)
    expect(variantMatchesDomain('ai', 'www.workbuddy.ai.evil.com')).toBe(false)
    expect(variantMatchesDomain('cn', 'www.workbuddy.ai')).toBe(false)
    expect(variantMatchesDomain('cn', 'www.codebuddy.cn')).toBe(true)
    expect(variantMatchesDomain('cn', '')).toBe(true)
    expect(variantMatchesDomain('ai', '   ')).toBe(true)
  })

  it('codebuddy domain normalizes workbuddy product domains', () => {
    expect(codebuddyDomainFor('', 'cn')).toBe('www.codebuddy.cn')
    expect(codebuddyDomainFor(null, 'ai')).toBe('www.codebuddy.ai')
    expect(codebuddyDomainFor('www.workbuddy.cn', 'cn')).toBe('www.codebuddy.cn')
    expect(codebuddyDomainFor('workbuddy.cn', 'cn')).toBe('www.codebuddy.cn')
    expect(codebuddyDomainFor('www.workbuddy.ai', 'ai')).toBe('www.codebuddy.ai')
    expect(codebuddyDomainFor('www.codebuddy.cn', 'cn')).toBe('www.codebuddy.cn')
    expect(codebuddyDomainFor('corp.example.com', 'cn')).toBe('corp.example.com')
    expect(codebuddyDomainFor('tencent.sso.codebuddy.cn', 'cn')).toBe('tencent.sso.codebuddy.cn')
  })
})

describe('paths', () => {
  const home = '/home/u'
  const cases: [WbVariant, string][] = [
    ['cn', '/home/u/AppData/Local/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info'],
    ['ai', '/home/u/AppData/Local/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.info'],
  ]
  it('auth file path covers windows for both variants', () => {
    for (const [variant, expected] of cases) {
      expect(authFilePathAt(home, 'windows', variant)).toBe(expected)
      expect(authFilePathAt(home, 'windows', variant)).toContain('CodeBuddyExtension')
    }
  })
  it('auth file path covers macos and linux dirs', () => {
    expect(authFilePathAt(home, 'macos', 'cn')).toBe(
      '/home/u/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info',
    )
    expect(authFilePathAt(home, 'linux', 'cn')).toBe(
      '/home/u/.local/share/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info',
    )
  })
  it('backup file names are distinguishable per variant', () => {
    expect(backupFileName('cn', '2026-09-15T00-00-00Z')).toBe('workbuddy-desktop.2026-09-15T00-00-00Z.info')
    expect(backupFileName('ai', '2026-09-15T00-00-00Z')).toBe('workbuddy-desktop-ai.2026-09-15T00-00-00Z.info')
  })
  it('data roots are distinguishable', () => {
    expect(dataRootAt(home, 'cn')).toBe('/home/u/.workbuddy')
    expect(dataRootAt(home, 'ai')).toBe('/home/u/.workbuddy-ai')
  })
})
