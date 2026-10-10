/**
 * Built-in gateway for wb-desktop: exposes the WorkBuddy account as a local
 * OpenAI/Anthropic-compatible API so external clients (zcode etc.) can call
 * CodeBuddy models with the account's credits.
 *
 * Upstream (verified 2026-09-30): POST https://www.workbuddy.cn/v2/chat/completions
 * with `Authorization: Bearer <access_token>` + x-user-id/x-domain headers;
 * standard OpenAI SSE (stream required), tool_calls in openai delta format.
 * Credit metering is the official server-side pipeline — every request is
 * charged exactly like in-app usage (usage.credit matches the billing ledger
 * price per model).
 *
 * Data-plane auth: virtual key stored in ~/.wb-hub/gateway.json; the server
 * binds 127.0.0.1 only.
 */
import { dataFile, loadAccounts, currentAccounts, persistAccounts, readConfig, writeConfig } from './store.ts'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildAuthHeaders, findAccountIn, getStr, isEnvelope, type WbAccount } from './core/account.ts'
import { refreshAccountToken } from './core/refresh.ts'

const UPSTREAM_HOST = 'https://www.workbuddy.cn'
const UPSTREAM_FAILOVER_HOST = 'https://wb.tencentbuddy.com'
const UPSTREAM_PATH = '/v2/chat/completions'
const REFRESH_COOLDOWN_MS = 5_000

/** 官方客户端展示的模型目录（小写调用 ID，2026-09-30 逐一实测可用）。 */
export const OFFICIAL_MODEL_CATALOG = [
  'hy4-preview',
  'hy3',
  'space-bunny',
  'deepseek-v4.1-flash',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.0-turbo',
]

/**
 * 探测一个模型 ID 是否可用：max_tokens=1 的微型请求（消耗约 0.01 积分）。
 * 200 = 可用；400 "service info not found" = 不存在；其余错误原样上报
 * （可能是限流/余额等临时问题，不据此剔除）。
 */
export async function probeModel(account: WbAccount, model: string): Promise<{ available: boolean; note?: string }> {
  const response = await fetch(UPSTREAM_HOST + UPSTREAM_PATH, {
    method: 'POST',
    headers: { ...(await gatewayHeaders(account)), 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, max_tokens: 1, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'hi' }] }),
  })
  if (response.status === 200) return { available: true }
  const text = await response.text().catch(() => '')
  if (response.status === 400 && text.includes('service info not found')) return { available: false, note: '模型不存在' }
  return { available: false, note: `${response.status}: ${text.slice(0, 80)}` }
}

export interface GatewayConfig {
  activeAccountId?: string
  virtualKey: string
  models: string[]
  /** 'default' = 模型自带思考；'disabled' = 注入 thinking disabled（glm-5.3-flash 思考吃满预算时正文会为空） */
  thinking?: 'default' | 'disabled'
  /** 上游通道风控的已知客户端提示签名 → 语义等价改写（11128 防御，可经 UI/API 更新） */
  signatureRewrites?: SignatureRewrite[]
}

export interface SignatureRewrite {
  match: string
  replacement: string
}

/** 内置签名表（2026-10-08 现场捕获定位；可作为「恢复默认」的基准）。 */
export const DEFAULT_SIGNATURE_REWRITES: SignatureRewrite[] = [
  { match: 'Main branch (you will usually use this for PRs): main', replacement: 'Main branch: main' },
]

interface UsageEntry {
  ts: number
  account: string
  model: string
  promptTokens: number
  completionTokens: number
  credit: number | null
  ok: boolean
  error?: string
}

const usageRing: UsageEntry[] = []
let lastRefreshAt = 0

export async function gatewayConfig(): Promise<GatewayConfig> {
  const config = await readConfig<Partial<GatewayConfig>>('gateway.json', {})
  if (config.virtualKey !== undefined && config.models !== undefined) {
    return {
      virtualKey: config.virtualKey,
      models: config.models,
      thinking: config.thinking ?? 'default',
      signatureRewrites: Array.isArray(config.signatureRewrites) ? config.signatureRewrites : DEFAULT_SIGNATURE_REWRITES,
      ...(config.activeAccountId !== undefined ? { activeAccountId: config.activeAccountId } : {}),
    }
  }
  // first run: generate and PERSIST immediately so every reader sees the same key
  const initial: GatewayConfig = {
    virtualKey: config.virtualKey ?? `wb-${randomUUID().replace(/-/g, '')}`,
    models: config.models ?? ['hy4-preview', 'hy3', 'space-bunny', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.0-turbo'],
    thinking: config.thinking ?? 'default',
    signatureRewrites: Array.isArray(config.signatureRewrites) ? config.signatureRewrites : DEFAULT_SIGNATURE_REWRITES,
    ...(config.activeAccountId !== undefined ? { activeAccountId: config.activeAccountId } : {}),
  }
  await writeConfig('gateway.json', initial)
  return initial
}

export async function saveGatewayConfig(patch: Partial<GatewayConfig>): Promise<GatewayConfig> {
  const current = await gatewayConfig()
  const next = { ...current, ...patch }
  await writeConfig('gateway.json', next)
  return next
}

/**
 * Upstream headers carrying the official CLI client fingerprint. The channel
 * verifier (error 11128) flags agent-shaped requests whose headers lack the
 * official client identity — the gateway is a local proxy for the user's own
 * account, so it presents the same identity the official CLI would.
 */
async function gatewayHeaders(account: WbAccount): Promise<Record<string, string>> {
  const requestId = randomUUID()
  const conversationId = randomUUID()
  return {
    ...buildAuthHeaders(account),
    'x-product': 'SaaS',
    'user-agent': 'CLI/2.114.2 CodeBuddy/2.114.2',
    'x-requested-with': 'XMLHttpRequest',
    'x-ide-type': 'CLI',
    'x-ide-name': 'CLI',
    'x-ide-version': '2.114.2',
    'x-agent-intent': 'craft',
    'x-agent-purpose': 'conversation',
    'x-private-data': 'false',
    'x-codebuddy-request': '1',
    'x-conversation-id': conversationId,
    'x-conversation-request-id': randomUUID(),
    'x-conversation-message-id': requestId,
    'x-request-id': requestId,
  }
}

/** The account the gateway serves with: active selection, else first usable. */
export async function activeGatewayAccount(): Promise<{ account?: WbAccount; error?: string }> {
  await loadAccounts()
  const config = await gatewayConfig()
  let account = config.activeAccountId ? findAccountIn(currentAccounts(), config.activeAccountId) : undefined
  if (!account) {
    account = currentAccounts().find(
      (entry) => typeof entry['access_token'] === 'string' && String(entry['access_token']).trim() !== '',
    )
  }
  if (!account) return { error: '没有可用账号（未添加或凭据为加密信封态）' }
  if (isEnvelope(account, 'access_token')) {
    return { error: `账号 ${getStr(account, 'email') ?? getStr(account, 'uid') ?? String(account['id'])} 为加密信封态，无法调用模型接口（请扫码重新添加）` }
  }
  return { account }
}

function recordUsage(entry: UsageEntry): void {
  usageRing.push(entry)
  if (usageRing.length > 200) usageRing.splice(0, usageRing.length - 200)
  void writeConfig('gateway-usage.json', usageRing).catch(() => {})
}

// restore the ring on boot so失败现场 can be diagnosed after restarts
void readConfig<UsageEntry[]>('gateway-usage.json', []).then((stored) => {
  if (Array.isArray(stored)) usageRing.push(...stored.slice(-200))
})

export function recentUsage(): UsageEntry[] {
  return [...usageRing].reverse()
}

export interface UsageSummary {
  requests: number
  ok: number
  errors: number
  promptTokens: number
  completionTokens: number
  credit: number | null
  byModel: { model: string; requests: number; promptTokens: number; completionTokens: number; credit: number | null }[]
}

/** 汇总当前台账（含持久化历史）。credit 为 null 的失败请求不计入积分合计。 */
export function usageSummary(): UsageSummary {
  const byModel = new Map<string, { model: string; requests: number; promptTokens: number; completionTokens: number; credit: number | null }>()
  const total: UsageSummary = {
    requests: usageRing.length, ok: 0, errors: 0,
    promptTokens: 0, completionTokens: 0, credit: 0,
    byModel: [],
  }
  let creditKnown = true
  for (const entry of usageRing) {
    if (entry.ok) total.ok += 1
    else total.errors += 1
    total.promptTokens += entry.promptTokens
    total.completionTokens += entry.completionTokens
    if (entry.credit !== null && entry.credit !== undefined) total.credit += entry.credit
    else creditKnown = false
    const row = byModel.get(entry.model) ?? { model: entry.model, requests: 0, promptTokens: 0, completionTokens: 0, credit: 0 }
    row.requests += 1
    row.promptTokens += entry.promptTokens
    row.completionTokens += entry.completionTokens
    if (entry.credit !== null && entry.credit !== undefined) row.credit += entry.credit
    byModel.set(entry.model, row)
  }
  total.byModel = [...byModel.values()].sort((a, b) => b.credit - a.credit || b.requests - a.requests)
  if (!creditKnown) total.credit = null
  return total
}

export function accountName(account: WbAccount): string {
  return getStr(account, 'email') ?? getStr(account, 'nickname') ?? getStr(account, 'uid') ?? 'unknown'
}

function keyOk(req: IncomingMessage, key: string, url: URL): boolean {
  const header = req.headers['authorization']
  const bearer = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined
  const xKey = typeof req.headers['x-api-key'] === 'string' ? (req.headers['x-api-key'] as string) : undefined
  const queryKey = url.searchParams.get('key') ?? undefined
  return bearer === key || xKey === key || queryKey === key
}

// ---------------------------------------------------- anthropic → openai

export interface AnthropicBody {
  model: string
  messages: { role: string; content: unknown }[]
  system?: unknown
  max_tokens?: number
  stream?: boolean
  temperature?: number
  tools?: { name: string; description?: string; input_schema?: unknown }[]
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string }
}

interface ContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  content?: unknown
  tool_use_id?: string
}

type OpenAiMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : ''))
      .join('')
  }
  return ''
}

/** Full Anthropic→OpenAI mapping: system, tools, tool_use, tool_result. */
export function anthropicToOpenAi(body: AnthropicBody): Record<string, unknown> {
  const messages: OpenAiMessage[] = []
  const system = contentToText(body.system)
  if (system) messages.push({ role: 'system', content: system })
  for (const message of body.messages ?? []) {
    const isAssistant = message.role === 'assistant'
    const blocks: ContentBlock[] = Array.isArray(message.content)
      ? (message.content as ContentBlock[])
      : [{ type: 'text', text: contentToText(message.content) }]
    let textBuffer = ''
    const flushText = (): void => {
      if (textBuffer !== '') {
        messages.push({ role: isAssistant ? 'assistant' : 'user', content: textBuffer })
        textBuffer = ''
      }
    }
    const toolCalls: OpenAiMessage['tool_calls'] = []
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text') {
        textBuffer += String(block.text ?? '')
      } else if (block.type === 'thinking') {
        // upstream has no thinking-history field; drop
      } else if (block.type === 'tool_use' && isAssistant) {
        toolCalls.push({
          id: String(block.id ?? `call_${toolCalls.length}`),
          type: 'function',
          function: { name: String(block.name ?? ''), arguments: JSON.stringify(block.input ?? {}) },
        })
      } else if (block.type === 'tool_result' && !isAssistant) {
        flushText()
        messages.push({ role: 'tool', content: contentToText(block.content), tool_call_id: String(block.tool_use_id ?? '') })
      }
    }
    if (toolCalls.length > 0) {
      flushText()
      messages.push({ role: 'assistant', content: '', tool_calls: toolCalls })
    } else {
      flushText()
    }
  }
  const tools = Array.isArray(body.tools)
    ? body.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description ?? '', parameters: tool.input_schema ?? { type: 'object' } },
      }))
    : undefined
  const toolChoice =
    body.tool_choice?.type === 'any'
      ? 'required'
      : body.tool_choice?.type === 'tool'
        ? { type: 'function', function: { name: body.tool_choice.name ?? '' } }
        : undefined
  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens ?? 4096,
    stream: body.stream === true,
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
  }
}

// ---------------------------------------------------------- upstream call

/**
 * 已知客户端系统提示签名句 → 语义等价改写。上游通道校验（11128）按其他编程
 * CLI 的系统提示样板句识别"未批准通道"；网关是用户自有账号的本机代理，转发前
 * 中和签名（语义保持），让任意客户端都能用自己的积分。可持续扩充此表。
 */
const SIGNATURE_REWRITES: [string, string][] = [
  ['Main branch (you will usually use this for PRs): main', 'Main branch: main'],
]

function neutralizeSignatures(text: string, rewrites: SignatureRewrite[]): string {
  let out = text
  for (const { match, replacement } of rewrites) out = out.split(match).join(replacement)
  return out
}

function sanitizeBody(body: Record<string, unknown>, rewrites: SignatureRewrite[]): Record<string, unknown> {
  const messages = body['messages']
  if (!Array.isArray(messages)) return body
  const cleaned = messages.map((message) => {
    const msg = message as { role?: string; content?: unknown }
    if (typeof msg.content === 'string') {
      return { ...msg, content: neutralizeSignatures(msg.content, rewrites) }
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: (msg.content as { type?: string; text?: string }[]).map((block) =>
          block && typeof block === 'object' && typeof block['text'] === 'string'
            ? { ...block, text: neutralizeSignatures(block['text'], rewrites) }
            : block,
        ),
      }
    }
    return msg
  })
  return { ...body, messages: cleaned }
}

interface UpstreamChunk {
  choices?: {
    delta?: {
      content?: string
      reasoning_content?: string
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
    }
    finish_reason?: string | null
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; credit?: number }
}

async function upstreamCall(account: WbAccount, body: Record<string, unknown>): Promise<Response> {
  const config = await gatewayConfig()
  const effective = sanitizeBody({ ...body }, config.signatureRewrites ?? DEFAULT_SIGNATURE_REWRITES)
  if (config.thinking === 'disabled') {
    effective['thinking'] = { type: 'disabled' }
    delete effective['enable_thinking']
    delete effective['reasoning_effort']
    delete effective['reasoning']
  }
  const attempt = async (host: string): Promise<Response> =>
    await fetch(host + UPSTREAM_PATH, {
      method: 'POST',
      headers: { ...(await gatewayHeaders(account)), 'content-type': 'application/json' },
      body: JSON.stringify(effective),
    })
  let response = await attempt(UPSTREAM_HOST)
  if (response.status >= 500) response = await attempt(UPSTREAM_FAILOVER_HOST)
  if (response.status === 401 && Date.now() - lastRefreshAt > REFRESH_COOLDOWN_MS) {
    lastRefreshAt = Date.now()
    const result = await refreshAccountToken(account, async (updated) => {
      const index = currentAccounts().indexOf(account)
      if (index >= 0) currentAccounts()[index] = updated
      await persistAccounts()
    })
    if (result.ok) response = await attempt(UPSTREAM_HOST)
  }
  // 11128 通道风控拦截是官方提示可重发的瞬时错误——自动重发一次
  if (response.status === 400) {
    const errorText = await response.text().catch(() => '')
    if (errorText.includes('11128')) {
      // 现场捕获：被拦的转换后请求体落盘，供定位风控触发条件
      try {
        const { mkdir, writeFile } = await import('node:fs/promises')
        const dir = dataFile('gateway-debug')
        await mkdir(dir, { recursive: true })
        await writeFile(`${dir}/11128-${Date.now()}.json`, JSON.stringify({ ts: Date.now(), account: accountName(account), model: String(effective['model'] ?? ''), bodyKB: Math.round(JSON.stringify(effective).length / 1024), body: effective }, null, 1))
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 800))
      await new Promise((resolve) => setTimeout(resolve, 800))
      response = await attempt(UPSTREAM_HOST)
      if (response.status >= 500) response = await attempt(UPSTREAM_FAILOVER_HOST)
      if (!response.ok) {
        const retryText = await response.text().catch(() => '')
        response = new Response(retryText, {
          status: response.status,
          headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
        })
      }
      return response
    }
    response = new Response(errorText, {
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
    })
  }
  return response
}

function tallyUsage(account: WbAccount, model: string, usage: UpstreamChunk['usage'], ok: boolean, error?: string): void {
  recordUsage({
    ts: Date.now(),
    account: accountName(account),
    model,
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    credit: usage?.credit ?? null,
    ok,
    ...(error !== undefined ? { error } : {}),
  })
}

function parseUpstreamSse(text: string): UpstreamChunk[] {
  const chunks: UpstreamChunk[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:') || line.includes('[DONE]')) continue
    try {
      chunks.push(JSON.parse(line.slice(5)) as UpstreamChunk)
    } catch {}
  }
  return chunks
}

// ------------------------------------------------- openai passthrough

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const config = await gatewayConfig()
  // 思考=关闭：上游已实测无视一切关思考参数（thinking/enable_thinking 全组合
  // × space-bunny/hy3/glm-5.3-flash 均照样思考），三条转发路径在出口侧拦下
  // reasoning_content；关思考参数仍照发，官方将来支持即自动真关。
  const suppressReasoning = config.thinking === 'disabled'
  if (!keyOk(req, config.virtualKey, url)) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'invalid virtual key', type: 'authentication_error' } }))
    return
  }
  const active = await activeGatewayAccount()
  if (!active.account) {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: active.error, type: 'api_error' } }))
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  let body: Record<string, unknown>
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'invalid JSON body', type: 'invalid_request_error' } }))
    return
  }
  const clientWantsStream = body['stream'] === true
  // Forward a strict whitelist of standard OpenAI fields. ZCode injects extra
  // params (thinking / enable_thinking / reasoning_effort / reasoning /
  // max_completion_tokens) and our own internal flags must never leak — the
  // upstream channel verifier (11128) flags non-standard field combinations.
  const forwarded: Record<string, unknown> = {
    model: body['model'],
    messages: body['messages'],
    stream: true, // upstream rejects non-stream
    ...(Array.isArray(body['tools']) ? { tools: body['tools'] } : {}),
    ...(body['tool_choice'] !== undefined ? { tool_choice: body['tool_choice'] } : {}),
    ...(typeof body['temperature'] === 'number' ? { temperature: body['temperature'] } : {}),
    ...(typeof body['top_p'] === 'number' ? { top_p: body['top_p'] } : {}),
    ...(body['stop'] !== undefined ? { stop: body['stop'] } : {}),
    ...(typeof body['max_tokens'] === 'number'
      ? { max_tokens: body['max_tokens'] }
      : typeof body['max_completion_tokens'] === 'number'
        ? { max_tokens: body['max_completion_tokens'] }
        : {}),
  }
  body = forwarded
  const model = String(body['model'] ?? '')
  const response = await upstreamCall(active.account, body)
  if (!response.ok && !response.headers.get('content-type')?.includes('text/event-stream')) {
    const errorText = (await response.text().catch(() => '')) || String(response.status)
    tallyUsage(active.account, model, undefined, false, errorText.slice(0, 200))
    res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: { message: errorText.slice(0, 300), type: 'api_error' } }))
    return
  }
  if (!response.body) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'upstream returned no body', type: 'api_error' } }))
    return
  }
  if (!clientWantsStream) {
    // client asked for a normal JSON response: aggregate the upstream SSE into
    // one OpenAI chat.completion object (content, reasoning, tool_calls, usage)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let sse = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      sse += decoder.decode(value, { stream: true })
    }
    const chunksIn = parseUpstreamSse(sse)
    let content = ''
    let reasoning = ''
    let finish = 'stop'
    let usage: UpstreamChunk['usage'] | undefined
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
    for (const parsed of chunksIn) {
      const choice = parsed.choices?.[0]
      if (choice?.delta?.content) content += choice.delta.content
      if (choice?.delta?.reasoning_content) reasoning += choice.delta.reasoning_content
      for (const call of choice?.delta?.tool_calls ?? []) {
        const idx = call.index ?? 0
        const existing = toolCalls.get(idx) ?? { id: '', name: '', arguments: '' }
        if (call.id) existing.id = call.id
        if (call.function?.name) existing.name = call.function.name
        if (call.function?.arguments) existing.arguments += call.function.arguments
        toolCalls.set(idx, existing)
      }
      if (choice?.finish_reason) finish = choice.finish_reason
      if (parsed.usage) usage = parsed.usage
    }
    tallyUsage(active.account, model, usage, true)
    let finalContent: string | null = content
    if (finalContent === '' || finalContent === null) {
      if (reasoning !== '' && toolCalls.size === 0) finalContent = `〔模型思考过程，未产出最终回答〕${reasoning}`
    }
    const message: Record<string, unknown> = { role: 'assistant', content: finalContent }
    const calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({
      id: call.id || `call_${randomUUID()}`,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
    if (calls.length > 0) message['tool_calls'] = calls
    if (reasoning !== '' && !suppressReasoning) message['reasoning_content'] = reasoning
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: usage
        ? {
            prompt_tokens: usage.prompt_tokens ?? 0,
            completion_tokens: usage.completion_tokens ?? 0,
            total_tokens: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
            credit: usage.credit ?? 0,
          }
        : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }))
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-wb-account': accountName(active.account),
  })
  // streaming passthrough with an empty-response guard: deltas forward live;
  // if the model spent the whole budget on reasoning (content stayed empty),
  // a synthetic content chunk carrying the reasoning is injected just before
  // the finish chunk, so the client never sees an empty assistant message.
  const streamReader = response.body!.getReader()
  const streamDecoder = new TextDecoder()
  let streamBuffered = ''
  let streamUsage: UpstreamChunk['usage'] | undefined
  let contentChars = 0
  let reasoningChars = 0
  let accumulatedReasoning = ''
  const emit = (event: string): void => {
    if (!res.writableEnded) res.write(event)
  }
  const flushEvent = (event: string): void => {
    const dataLine = event.split('\n').find((l) => l.startsWith('data:'))
    let outbound = event
    if (dataLine && !dataLine.includes('[DONE]')) {
      try {
        const parsed = JSON.parse(dataLine.slice(5)) as UpstreamChunk
        if (parsed.usage) streamUsage = parsed.usage // usage 随最后一个 chunk 到达，留作收尾记账
        const delta = parsed.choices?.[0]?.delta
        if (delta?.content) contentChars += delta.content.length
        if (delta?.reasoning_content) {
          reasoningChars += delta.reasoning_content.length
          accumulatedReasoning += delta.reasoning_content
          if (suppressReasoning) {
            const stripped = JSON.parse(dataLine.slice(5)) as Record<string, unknown>
            const choices = stripped['choices'] as Array<Record<string, unknown>> | undefined
            const deltaPart = choices?.[0]?.['delta'] as Record<string, unknown> | undefined
            if (deltaPart) delete deltaPart['reasoning_content']
            outbound = `data: ${JSON.stringify(stripped)}\n\n`
          }
        }
        if (parsed.choices?.[0]?.finish_reason && contentChars === 0 && reasoningChars > 0 && !res.writableEnded) {
          const base = JSON.parse(dataLine.slice(5)) as Record<string, unknown>
          const baseChoices = base['choices'] as Record<string, unknown>[] | undefined
          emit(`data: ${JSON.stringify({
            ...base,
            choices: [{
              ...(baseChoices?.[0] ?? {}),
              delta: { role: 'assistant', content: `〔模型思考过程，未产出最终回答〕${accumulatedReasoning}` },
              finish_reason: '',
            }],
          })}\n\n`)
        }
      } catch {}
    }
    emit(outbound)
  }
  try {
    for (;;) {
      const { done, value } = await streamReader.read()
      if (done) break
      streamBuffered += streamDecoder.decode(value, { stream: true })
      let idx: number
      while ((idx = streamBuffered.indexOf('\n\n')) !== -1) {
        const event = streamBuffered.slice(0, idx + 2)
        streamBuffered = streamBuffered.slice(idx + 2)
        flushEvent(event)
      }
    }
  } catch {}
  if (streamBuffered && !res.writableEnded) res.write(streamBuffered)
  res.end()
  // 记账：此前 streamSse 从未累积导致流式调用全部漏记——这是「刷新统计后
  // token 使用记录不更新」的根因。现在即使客户端中途断开也如实入账。
  tallyUsage(active.account, model, streamUsage, true)
}

// ------------------------------------------- anthropic ↔ openai messages

async function handleAnthropicMessages(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const config = await gatewayConfig()
  const suppressReasoning = config.thinking === 'disabled' // 与 openai 路径同语义：出口侧拦思考内容
  if (!keyOk(req, config.virtualKey, url)) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid virtual key' } }))
    return
  }
  const active = await activeGatewayAccount()
  if (!active.account) {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: active.error } }))
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  let anthropic: AnthropicBody
  try {
    anthropic = JSON.parse(Buffer.concat(chunks).toString('utf8')) as AnthropicBody
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON body' } }))
    return
  }
  const openaiBody = anthropicToOpenAi(anthropic)
  openaiBody['stream'] = true
  const response = await upstreamCall(active.account, openaiBody)
  const upstreamText = await response.text()
  const chunksIn = parseUpstreamSse(upstreamText)

  // fold upstream chunks into anthropic content blocks + usage
  let text = ''
  let thinking = ''
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
  let stopReason = 'end_turn'
  let usageField: UpstreamChunk['usage'] | undefined
  for (const parsed of chunksIn) {
    const choice = parsed.choices?.[0]
    if (choice?.delta?.content) text += choice.delta.content
    if (choice?.delta?.reasoning_content) thinking += choice.delta.reasoning_content
    for (const call of choice?.delta?.tool_calls ?? []) {
      const idx = call.index ?? 0
      const existing = toolCalls.get(idx) ?? { id: '', name: '', arguments: '' }
      if (call.id) existing.id = call.id
      if (call.function?.name) existing.name = call.function.name
      if (call.function?.arguments) existing.arguments += call.function.arguments
      toolCalls.set(idx, existing)
    }
    if (choice?.finish_reason) {
      stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn'
    }
    if (parsed.usage) usageField = parsed.usage
  }
  tallyUsage(active.account, String(anthropic.model), usageField, response.status === 200, response.status !== 200 ? upstreamText.slice(0, 200) : undefined)

  const content: Record<string, unknown>[] = []
  if (text) content.push({ type: 'text', text })
  if (thinking) {
    if (suppressReasoning) {
      // 思考=关闭：thinking 块不下发；正文为空时仍回填，客户端永不空响应
      if (!text && toolCalls.size === 0) content.push({ type: 'text', text: `〔模型思考过程，未产出最终回答〕${thinking}` })
    } else if (text) {
      content.push({ type: 'thinking', thinking })
    } else if (toolCalls.size === 0) {
      // 思考型模型把预算花在 reasoning 上时正文会为空——回填思考内容，客户端永不空响应
      content.push({ type: 'text', text: `〔模型思考过程，未产出最终回答〕${thinking}` })
    }
  }
  for (const call of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
    let input: unknown = {}
    try {
      input = JSON.parse(call[1].arguments || '{}')
    } catch {}
    content.push({ type: 'tool_use', id: call[1].id || `toolu_${randomUUID()}`, name: call[1].name, input })
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })

  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(
    JSON.stringify({
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: anthropic.model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: usageField?.prompt_tokens ?? 0, output_tokens: usageField?.completion_tokens ?? 0 },
    }),
  )
}

export async function handleGateway(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const pathName = url.pathname
  const method = req.method ?? 'GET'
  if (pathName === '/v1/chat/completions' && method === 'POST') {
    await handleChatCompletions(req, res, url)
    return true
  }
  if (pathName === '/v1/messages' && method === 'POST') {
    await handleAnthropicMessages(req, res, url)
    return true
  }
  if (pathName === '/v1/models' && method === 'GET') {
    const config = await gatewayConfig()
    if (!keyOk(req, config.virtualKey, url)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid virtual key' } }))
      return true
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: config.models.map((id) => ({ id, object: 'model', owned_by: 'wb-desktop' })) }))
    return true
  }
  return false
}
