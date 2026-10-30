/**
 * MCP stdio server: exposes the wb-desktop control plane as native MCP tools
 * for local AI clients (Claude Code / ZCode etc.). Hand-rolled JSON-RPC over
 * stdin/stdout — zero dependencies. The client launches this process; it talks
 * to the loopback control plane (default http://127.0.0.1:3081, override with
 * WB_PORT) which has NO auth by design — never point it at a remote host.
 *
 * Register (Claude Code):  claude mcp add wb-desktop -- node <dist>/mcp.cjs
 * Register (ZCode):        add an MCP server with command `node`, args [<dist>/mcp.cjs]
 */

const PORT = Number(process.env.WB_PORT ?? 3081)
const BASE = `http://127.0.0.1:${PORT}`

async function api(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, timeoutMs = 120_000): Promise<unknown> {
  const response = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { httpStatus: response.status, raw: text.slice(0, 400) }
  }
}

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const TOOLS: ToolDef[] = [
  { name: 'wb_status', description: '查看 wb-desktop 运行状态：本地端口/局域网网关/运行时长/当前服务账号', inputSchema: { type: 'object', properties: {} } },
  { name: 'wb_accounts', description: '列出已配置账号（已脱敏，无 token）。用返回的 id 做切换/刷新等操作', inputSchema: { type: 'object', properties: {} } },
  { name: 'wb_credits', description: '实时查询各账号积分余额与到期时间（逐个请求官方接口，稍慢）', inputSchema: { type: 'object', properties: {} } },
  { name: 'wb_checkin_run', description: '立即为所有符合条件的账号签到一轮（强制，不受时间窗限制）', inputSchema: { type: 'object', properties: {} } },
  { name: 'wb_checkin_logs', description: '查看最近的签到结果记录', inputSchema: { type: 'object', properties: {} } },
  { name: 'wb_travel_status', description: '查看猫猫旅行状态', inputSchema: { type: 'object', properties: { refresh: { type: 'boolean', description: '是否强制向官方刷新' } } } },
  { name: 'wb_travel_run', description: '手动触发一次猫猫旅行派发', inputSchema: { type: 'object', properties: {} } },
  { name: 'wb_travel_claim', description: '手动触发一次猫猫旅行奖励领取', inputSchema: { type: 'object', properties: {} } },
  { name: 'wb_switch_account', description: '切换网关服务账号（写入官方客户端登录态并重启其进程）', inputSchema: { type: 'object', properties: { id: { type: 'string', description: '账号 id，来自 wb_accounts' } }, required: ['id'] } },
  { name: 'wb_refresh_account', description: '手动刷新单个账号的 token', inputSchema: { type: 'object', properties: { id: { type: 'string', description: '账号 id，来自 wb_accounts' } }, required: ['id'] } },
  { name: 'wb_gateway_usage', description: '查看网关调用统计（请求数/tokens/积分，按模型汇总）与最近调用明细', inputSchema: { type: 'object', properties: {} } },
  { name: 'wb_logs', description: '查看运行日志（后台签到/旅行/保活/请求处理事件，最近 200 条）', inputSchema: { type: 'object', properties: {} } },
]

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'wb_status':
      return await api('/api/status')
    case 'wb_accounts':
      return await api('/api/accounts')
    case 'wb_credits':
      return await api('/api/credits', 'GET', undefined, 180_000)
    case 'wb_checkin_run':
      return await api('/api/checkin/run', 'POST', {}, 180_000)
    case 'wb_checkin_logs':
      return await api('/api/checkin/logs')
    case 'wb_travel_status':
      return await api(`/api/travel/status${args.refresh === true ? '?refresh=1' : ''}`, 'GET', undefined, 180_000)
    case 'wb_travel_run':
      return await api('/api/travel/run', 'POST', {}, 180_000)
    case 'wb_travel_claim':
      return await api('/api/travel/claim', 'POST', {}, 180_000)
    case 'wb_switch_account':
      return await api('/api/switch', 'POST', { id: String(args.id ?? '') }, 180_000)
    case 'wb_refresh_account':
      return await api(`/api/refresh/${String(args.id ?? '')}`, 'POST', {})
    case 'wb_gateway_usage':
      return await api('/api/gateway/config')
    case 'wb_logs':
      return await api('/api/logs')
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

interface RpcRequest {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

function reply(id: number | string | null, result?: unknown, error?: { code: number; message: string }): void {
  const payload = error !== undefined ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

export async function runMcpStdio(): Promise<void> {
  let buffer = ''
  for await (const chunk of process.stdin) {
    buffer += typeof chunk === 'string' ? chunk : String(chunk)
    let idx: number
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line === '') continue
      let req: RpcRequest
      try {
        req = JSON.parse(line) as RpcRequest
      } catch {
        continue
      }
      if (!req.method) continue
      if (req.method === 'initialize') {
        const requested = String((req.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? '2024-11-05')
        reply(req.id ?? null, {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { name: 'wb-desktop', version: '0.3.0' },
        })
        continue
      }
      if (req.method.startsWith('notifications/')) continue
      if (req.method === 'tools/list') {
        reply(req.id ?? null, { tools: TOOLS })
        continue
      }
      if (req.method === 'tools/call') {
        const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
        try {
          const result = await callTool(String(params.name ?? ''), params.arguments ?? {})
          reply(req.id ?? null, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
        } catch (error) {
          reply(req.id ?? null, { content: [{ type: 'text', text: `工具调用失败：${error instanceof Error ? error.message : String(error)}` }], isError: true })
        }
        continue
      }
      if (req.id !== undefined && req.id !== null) reply(req.id, undefined, { code: -32601, message: `method not found: ${req.method}` })
    }
  }
}

// 直接运行本模块即进入 stdio 服务（node dist/mcp.cjs）
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('mcp.cjs')) {
  runMcpStdio().catch((error: unknown) => {
    console.error('[wb-mcp] 启动失败:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
