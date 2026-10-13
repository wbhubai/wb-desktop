/**
 * wb-desktop HTTP servers.
 * - Control plane (UI + REST): 127.0.0.1 only — a local single-user desktop
 *   app follows workbuddy-switch's loopback model; it has NO auth by design.
 * - LAN data plane (default :9527 on 0.0.0.0): forwards /v1/* to the gateway
 *   ONLY — every handler enforces the virtual key, and nothing else (UI,
 *   accounts, configs) is reachable through it. WB_LAN_PORT=0 disables.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import {
  checkinCycle,
  growthCycle,
  importLocal,
  oauth,
  pushLog,
  queryCredit,
  recentLogs,
  refreshOne,
  removeAccount,
  switchTo,
  travelCycle,
  travelStatusPage,
} from './app.ts'
import { accountMeta, getStr } from './core/account.ts'
import { defaultCheckinConfig } from './core/checkin.ts'
import { currentAccounts, loadAccounts, readConfig, readList, writeConfig, dataFile } from './store.ts'

// Bundled by esbuild (build.mjs define); in tsx dev mode falls back to reading the file.
declare const __UI_HTML__: string | undefined
import { activeGatewayAccount, gatewayConfig, handleGateway, probeModel, recentUsage, refreshRemoteRules, saveGatewayConfig, syncModelCatalog, usageSummary, type ModelInfo } from './gateway.ts'
import { startBackgroundLoops } from './loops.ts'

const startedAt = Date.now()
let controlPort = 0

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 16 * 1024 * 1024) throw new Error('请求体过大')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return undefined
  return JSON.parse(text) as Record<string, unknown>
}

function replyJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathName = url.pathname
  const method = req.method ?? 'GET'
  try {
    if (method === 'GET' && (pathName === '/' || pathName === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(typeof __UI_HTML__ !== 'undefined' ? __UI_HTML__ : (await import('node:fs')).readFileSync(new URL('./ui.html', import.meta.url), 'utf8'))
      return
    }
    if (await handleGateway(req, res, url)) return
    if (!pathName.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    const route = pathName.replace(/^\/api/, '') || '/'
    const body = method === 'POST' || method === 'DELETE' ? ((await readJsonBody(req)) ?? {}) : {}

    if (route === '/login/start' && method === 'POST') {
      const variant = body['variant'] === 'ai' ? 'ai' : 'cn'
      const start = await oauth.oauthStart(variant)
      return replyJson(res, 200, start)
    }
    if (route === '/login/poll' && method === 'GET') {
      return replyJson(res, 200, await oauth.oauthPoll(url.searchParams.get('loginId') ?? ''))
    }
    if (route === '/accounts' && method === 'GET') {
      await loadAccounts()
      return replyJson(res, 200, { accounts: currentAccounts().map(accountMeta) })
    }
    const deleteMatch = /^\/accounts\/([A-Za-z0-9-]+)$/.exec(route)
    if (deleteMatch && method === 'DELETE') {
      return replyJson(res, (await removeAccount(deleteMatch[1]!)) ? 200 : 404, { ok: true })
    }
    if (route === '/accounts/import-local' && method === 'POST') {
      return replyJson(res, 200, await importLocal(body['variant'] === 'ai' ? 'ai' : 'cn'))
    }
    if (route === '/switch' && method === 'POST') {
      return replyJson(res, 200, await switchTo(String(body['id'] ?? ''), body['restart'] !== false))
    }
    const refreshMatch = /^\/refresh\/([A-Za-z0-9-]+)$/.exec(route)
    if (refreshMatch && method === 'POST') {
      return replyJson(res, 200, await refreshOne(refreshMatch[1]!))
    }
    if (route === '/credits' && method === 'GET') {
      await loadAccounts()
      const results = []
      for (const record of currentAccounts()) results.push(await queryCredit(record))
      return replyJson(res, 200, { results, generatedAt: Date.now() })
    }
    if (route === '/checkin/config' && method === 'GET') {
      return replyJson(res, 200, await readConfig('checkin-config.json', defaultCheckinConfig(false)))
    }
    if (route === '/checkin/config' && method === 'POST') {
      const current = await readConfig<Record<string, unknown>>('checkin-config.json', defaultCheckinConfig(false))
      const merged = { ...current, ...pickConfig(body, current) }
      await writeConfig('checkin-config.json', merged)
      return replyJson(res, 200, merged)
    }
    if (route === '/checkin/run' && method === 'POST') {
      return replyJson(res, 200, await checkinCycle(true))
    }
    if (route === '/checkin/logs' && method === 'GET') {
      return replyJson(res, 200, { logs: await readList('checkin-logs.json') })
    }
    if (route === '/travel/status' && method === 'GET') {
      return replyJson(res, 200, await travelStatusPage(url.searchParams.get('refresh') === '1'))
    }
    if (route === '/travel/config' && method === 'POST') {
      await writeConfig('travel-config.json', { enabled: body['enabled'] === true })
      return replyJson(res, 200, { enabled: body['enabled'] === true })
    }
    if (route === '/growth/run' && method === 'POST') {
      return replyJson(res, 200, await growthCycle(true))
    }
    if (route === '/travel/run' && method === 'POST') {
      return replyJson(res, 200, await travelCycle('dispatch', true))
    }
    if (route === '/travel/claim' && method === 'POST') {
      return replyJson(res, 200, await travelCycle('claim', true))
    }
    if (route === '/status' && method === 'GET') {
      const config = await gatewayConfig()
      await loadAccounts()
      const accounts = currentAccounts().map((account) => ({
        id: getStr(account, 'id'),
        name: getStr(account, 'email') ?? getStr(account, 'nickname') ?? 'unknown',
      }))
      const active = accounts.find((account) => account.id === config.activeAccountId)
      return replyJson(res, 200, {
        localPort: controlPort,
        lan: lanGatewayPort() > 0 ? { hosts: lanIPv4s(), port: lanGatewayPort() } : null,
        gateway: {
          hasKey: Boolean(config.virtualKey),
          models: (config.models ?? []).length,
          activeAccountId: config.activeAccountId ?? null,
          activeAccountName: active?.name ?? null,
        },
        startedAt,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      })
    }
    if (route === '/gateway/config' && method === 'GET') {
      const config = await gatewayConfig()
      await loadAccounts()
      return replyJson(res, 200, {
        ...config,
        lan: lanGatewayPort() > 0 ? { hosts: lanIPv4s(), port: lanGatewayPort() } : null,
        usage: recentUsage().slice(0, 100),
        summary: usageSummary(),
        accounts: currentAccounts().map((account) => ({
          id: getStr(account, 'id'),
          name: getStr(account, 'email') ?? getStr(account, 'nickname') ?? 'unknown',
          usable: typeof account['access_token'] === 'string' && String(account['access_token']).trim() !== '',
        })),
      })
    }
    if (route === '/gateway/config' && method === 'POST') {
      const patch: Record<string, unknown> = {}
      if (typeof body['activeAccountId'] === 'string' || body['activeAccountId'] === null) patch['activeAccountId'] = body['activeAccountId']
      if (Array.isArray(body['models'])) {
        // 全量编辑模型清单：保留既有条目元数据，新增记 manual，缺席即删除
        const current = await gatewayConfig()
        const meta = new Map((current.modelCatalog ?? []).map((entry) => [entry.id, entry]))
        patch['modelCatalog'] = (body['models'] as unknown[])
          .map((id) => String(id).trim())
          .filter((id: string) => id !== '')
          .map((id: string) => meta.get(id) ?? ({ id, source: 'manual' } satisfies ModelInfo))
      }
      if (body['thinking'] === 'default' || body['thinking'] === 'disabled') patch['thinking'] = body['thinking']
      if (typeof body['rulesUrl'] === 'string') patch['rulesUrl'] = body['rulesUrl'].trim()
      if (Array.isArray(body['signatureRewrites'])) {
        const rewrites = body['signatureRewrites']
          .filter((r: unknown) => r !== null && typeof r === 'object')
          .map((r: { match?: unknown; replacement?: unknown }) => ({ match: String(r['match'] ?? ''), replacement: String(r['replacement'] ?? '') }))
          .filter((r: { match: string }) => r.match !== '')
        patch['signatureRewrites'] = rewrites
      }
      return replyJson(res, 200, await saveGatewayConfig(patch))
    }
    if (route === '/gateway/rules/refresh' && method === 'POST') {
      return replyJson(res, 200, await refreshRemoteRules())
    }
    if (route === '/gateway/models/sync' && method === 'POST') {
      const result = await syncModelCatalog()
      return replyJson(res, result.error !== undefined ? 503 : 200, result)
    }
    if (route === '/gateway/models/refresh' && method === 'POST') {
      const active = await activeGatewayAccount()
      if (!active.account) return replyJson(res, 503, { error: active.error })
      const config = await gatewayConfig()
      const candidates = [...new Set((config.modelCatalog ?? []).map((entry) => entry.id))]
      const report: { id: string; available: boolean; note?: string }[] = []
      const kept: ModelInfo[] = []
      for (const candidate of candidates) {
        const result = await probeModel(active.account, candidate)
        report.push({ id: candidate, available: result.available, ...(result.note !== undefined ? { note: result.note } : {}) })
        // 仅上游确认不存在（400 service info not found）才移除；临时错误原样保留
        if (result.exists !== false) {
          const meta = (config.modelCatalog ?? []).find((entry) => entry.id === candidate)
          if (meta) kept.push(meta)
        }
      }
      await saveGatewayConfig({ modelCatalog: kept })
      return replyJson(res, 200, { models: kept.map((entry) => entry.id), report })
    }
    if (route === '/gateway/key/rotate' && method === 'POST') {
      return replyJson(res, 200, await saveGatewayConfig({ virtualKey: `wb-${crypto.randomUUID().replace(/-/g, '')}` }))
    }
    if (route === '/logs' && method === 'GET') {
      return replyJson(res, 200, { logs: recentLogs() })
    }
    return replyJson(res, 404, { error: `unknown path: ${route}` })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[wb] 请求处理失败: ${message}`, error instanceof Error ? error.stack : '')
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: message }))
    } else {
      res.end()
    }
  }
}

function pickConfig(body: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(current)) {
    if (key in body) out[key] = body[key]
  }
  return out
}

/** Non-loopback IPv4s of this machine, RFC1918 private ranges first — the
 * first entry is the best LAN-endpoint guess (VPN/fake-ip adapters sort last). */
function lanIPv4s(): string[] {
  const all: string[] = []
  for (const list of Object.values(networkInterfaces()))
    for (const net of list ?? [])
      if (net.family === 'IPv4' && !net.internal) all.push(net.address)
  const isPrivate = (ip: string): boolean => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)
  return [...all].sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)))
}

/** First non-loopback IPv4 of this machine, for the LAN endpoint hint. */
function lanIPv4(): string | undefined {
  return lanIPv4s()[0]
}

function lanGatewayPort(): number {
  return Number(process.env.WB_LAN_PORT ?? 9527)
}

/**
 * LAN-facing data-plane listener: forwards /v1/* to the gateway only (the
 * virtual key is enforced inside every gateway handler). The UI, the local
 * control plane and account data are never reachable through it.
 */
export async function startLanGateway(port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://lan')
        if (!(await handleGateway(req, res, url))) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: { message: 'not found: LAN listener serves /v1/* only', type: 'invalid_request_error' } }))
        }
      })().catch(() => {
        if (!res.writableEnded) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: { message: 'internal error', type: 'api_error' } }))
        }
      })
    })
    server.on('error', reject)
    server.listen(port, host, () => resolve())
  })
  console.log(`wb-desktop: lan gateway http://${host === '0.0.0.0' ? (lanIPv4() ?? host) : host}:${port}/v1`)
}

export async function startServer(port: number): Promise<void> {
  controlPort = port
  await new Promise<void>((resolve, reject) => {
    const server = createServer((req, res) => void handle(req, res))
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      console.log(`wb-desktop: http://127.0.0.1:${port}`)
      resolve()
    })
  })
  if (lanGatewayPort() > 0) await startLanGateway(lanGatewayPort(), process.env.WB_LAN_HOST || '0.0.0.0')
  pushLog('info', 'wb-desktop 已启动')
  startBackgroundLoops()
}
