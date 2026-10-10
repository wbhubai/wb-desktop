import { describe, expect, it } from 'vitest'
import { buildAccountFromOauth, domainMismatchError, OAuthFlow, oauthProfileEmail } from './oauth.ts'
import type { HttpFetcher } from './util.ts'

describe('profile email extraction', () => {
  it('without email does not use nickname or uid', () => {
    expect(oauthProfileEmail({ uid: 'u1', nickname: 'nick' })).toBeUndefined()
  })
  it('keeps factual email', () => {
    expect(oauthProfileEmail({ email: ' user@example.com ' })).toBe('user@example.com')
  })
})

describe('account construction', () => {
  it('builds the wbs account record shape', () => {
    const account = buildAccountFromOauth({
      tokenData: {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: 1_791_912_333_558,
        domain: 'www.codebuddy.cn',
      },
      profileData: { uid: 'u1', nickname: 'nick', email: 'a@x.com', enterpriseId: 'e1' },
      tokenDomain: 'www.codebuddy.cn',
      variant: 'cn',
      accessToken: 'at',
      now: 1_700_000_000_000,
    })
    expect(account['uid']).toBe('u1')
    expect(account['email']).toBe('a@x.com')
    expect(account['refresh_token']).toBe('rt')
    expect(account['token_type']).toBe('Bearer')
    expect(account['expiresAt']).toBe(1_791_912_333_558)
    expect(account['variant']).toBe('cn')
    expect(account['createdAt']).toBe(1_700_000_000_000)
    expect((account['auth_raw'] as Record<string, unknown>)['accessToken']).toBe('at')
  })
  it('relative expiresIn seconds convert to ms', () => {
    const account = buildAccountFromOauth(
      {
        tokenData: { access_token: 'at', expiresIn: 3600 },
        profileData: {},
        tokenDomain: '',
        variant: 'cn',
        accessToken: 'at',
        now: 1_700_000_000_000,
      },
    )
    expect(account['expiresAt']).toBe(1_700_000_000_000 + 3_600_000)
  })
})

describe('domain mismatch gate', () => {
  it('is rejected per variant', () => {
    expect(domainMismatchError('ai', 'www.codebuddy.cn')).toContain('国际版')
    expect(domainMismatchError('cn', 'www.workbuddy.ai')).toContain('国内版')
  })
})

const okJson = (body: unknown): HttpFetcher => async () => body as never

describe('flow urls', () => {
  it('follow the initiating variant', () => {
    const flow = new OAuthFlow(async () => ({}))
    const cn = flow.oauthUrls('cn')
    expect(cn.state).toBe('https://www.codebuddy.cn/v2/plugin/auth/state?platform=workbuddy')
    expect(cn.token).toBe('https://www.codebuddy.cn/v2/plugin/auth/token')
    expect(cn.account).toBe('https://www.codebuddy.cn/v2/plugin/login/account')
    const ai = flow.oauthUrls('ai')
    expect(ai.state).toBe('https://www.workbuddy.ai/v2/plugin/auth/state?platform=workbuddy-ai')
    expect(ai.account).toBe('https://www.workbuddy.ai/v2/plugin/login/account')
  })
})

describe('oauth state machine', () => {
  it('records its own variant per loginId', async () => {
    const requests: { url: string; method: string; body?: unknown }[] = []
    const http: HttpFetcher = async (url, method, body) => {
      requests.push({ url, method, body })
      if (url.includes('/auth/state')) {
        const platform = url.includes('platform=workbuddy-ai') ? 'ai' : 'cn'
        return { code: 0, data: { state: `st-${platform}`, authUrl: `https://login.example/${platform}` } }
      }
      return { code: 1 }
    }
    const flow = new OAuthFlow(async (account) => account, { http })
    const cn = await flow.oauthStart('cn')
    const ai = await flow.oauthStart('ai')
    expect(cn.verificationUri).toContain('/cn')
    expect(ai.verificationUri).toContain('/ai')
    const cnPoll = await flow.oauthPoll(cn.loginId)
    expect(cnPoll.done).toBe(false) // code 1 → keep polling
    const stateReq = requests.find((request) => request.url.includes('/auth/state?platform=workbuddy-ai'))
    expect(stateReq).toBeDefined()
    expect(stateReq!.method).toBe('POST')
  })
  it('unknown loginId reports done with error', async () => {
    const flow = new OAuthFlow(async (account) => account)
    const result = await flow.oauthPoll('missing')
    expect(result.done).toBe(true)
    expect(result.error).toBe('登录请求不存在')
  })
  it('full success path saves the account', async () => {
    const http: HttpFetcher = async (url) => {
      if (url.includes('/auth/state')) return { code: 0, data: { state: 'st-1' } }
      if (url.includes('/auth/token')) return { code: 0, data: { accessToken: 'at', domain: 'www.workbuddy.ai' } }
      if (url.includes('/login/account')) return { code: 0, data: { uid: 'u9', nickname: 'intl' } }
      throw new Error('unexpected ' + url)
    }
    let saved: Record<string, unknown> | undefined
    const flow = new OAuthFlow(async (account) => {
      saved = account
      return { id: 'meta' }
    }, { http })
    const start = await flow.oauthStart('ai')
    expect(start.verificationUri).toBeTruthy()
    const poll = await flow.oauthPoll(start.loginId)
    expect(poll.done).toBe(true)
    expect(poll.result).toEqual({ id: 'meta' })
    expect(saved?.['uid']).toBe('u9')
    expect(saved?.['variant']).toBe('ai')
  })
  it('domain mismatch is rejected and never persisted', async () => {
    const http: HttpFetcher = async (url) => {
      if (url.includes('/auth/state')) return { code: 0, data: { state: 'st-1' } }
      if (url.includes('/auth/token')) return { code: 0, data: { accessToken: 'at', domain: 'www.codebuddy.cn' } }
      throw new Error('unexpected ' + url)
    }
    let saveCalls = 0
    const flow = new OAuthFlow(async (account) => {
      saveCalls++
      return account
    }, { http })
    const start = await flow.oauthStart('ai')
    const poll = await flow.oauthPoll(start.loginId)
    expect(poll.done).toBe(true)
    expect(poll.error).toContain('档位不符')
    expect(saveCalls).toBe(0)
    // repeated polls see the same error
    const again = await flow.oauthPoll(start.loginId)
    expect(again.error).toContain('档位不符')
  })
})
