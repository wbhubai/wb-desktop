/**
 * upstreamCall / gatewayConfig 的端到端行为：只替换全局 fetch 和 home 目录
 * （gateway.json 落在临时目录），不打真实上游。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const START = new Date('2026-11-10T09:00:00').getTime()

const savedEnv = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] }
let home: string
let fetchCalls: string[]

const account = { id: 'a1', email: 'a1@x.com', access_token: 'token-a1', variant: 'cn' }

async function importGateway() {
  vi.resetModules()
  return await import('./gateway.ts')
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'wb-gw-'))
  process.env['HOME'] = home
  process.env['USERPROFILE'] = home
  fetchCalls = []
  vi.stubGlobal('fetch', (async (input: unknown) => {
    fetchCalls.push(String(input instanceof Request ? input.url : input))
    return new Response(JSON.stringify({ code: 0, choices: [{ message: { content: 'ok' } }] }), { status: 200 })
  }) as typeof fetch)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(home, { recursive: true, force: true })
})

describe('upstream concurrency slot vs client abort', () => {
  it('does not call upstream when the client already disconnected', async () => {
    const { upstreamCall } = await importGateway()
    const controller = new AbortController()
    controller.abort()
    await expect(upstreamCall(account, { model: 'hy3' }, controller.signal)).rejects.toThrow()
    expect(fetchCalls).toHaveLength(0)
  })

  it('still calls upstream for a connected client', async () => {
    const { upstreamCall } = await importGateway()
    const controller = new AbortController()
    const response = await upstreamCall(account, { model: 'hy3' }, controller.signal)
    expect(response.status).toBe(200)
    expect(fetchCalls).toHaveLength(1)
  })
})

describe('gateway.json corruption guard', () => {
  it('never resets the config when the file exists but is unreadable', async () => {
    const { gatewayConfig } = await importGateway()
    const store = path.join(home, '.wb-hub')
    await mkdir(store, { recursive: true })
    const file = path.join(store, 'gateway.json')
    await writeFile(file, '{broken')
    await expect(gatewayConfig()).rejects.toThrow(/无法读取/)
    expect(await readFile(file, 'utf8')).toBe('{broken')
    // 修复文件后恢复正常读取，且 Key 来自文件而不是重新生成
    await writeFile(file, JSON.stringify({ virtualKey: 'wb-keep-me', models: ['hy3'] }))
    const config = await gatewayConfig()
    expect(config.virtualKey).toBe('wb-keep-me')
    expect(await readFile(file, 'utf8')).toContain('wb-keep-me')
  })
})
