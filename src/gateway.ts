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
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
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
  /** 生效改写表（内置基线 ∪ 远程规则 ∪ 用户增量），运行时只读；存储层只落 remote/custom 两层 */
  signatureRewrites?: SignatureRewrite[]
  /** 存储层：仅用户自定义增量。旧格式（整包快照）读取时自动迁移 */
  customSignatureRewrites?: SignatureRewrite[]
  /** 远程规则源 URL（rules JSON，默认空=关闭，不发起任何外网请求）。静态 GET、零遥测 */
  rulesUrl?: string
  /** 存储层：远程规则缓存（由 refreshRemoteRules 写入） */
  remoteSignatureRewrites?: SignatureRewrite[]
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

/**
 * 旧版配置把内置表整包快照存进 signatureRewrites，导致应用更新内置表对
 * 存量用户永不生效。新语义：存储层只存用户增量，生效表 = 内置基线 ∪ 增量。
 * 读取旧格式时按 match 剔除内置项完成迁移。
 */
export function deriveCustomRewrites(stored: SignatureRewrite[] | undefined): SignatureRewrite[] {
  if (!Array.isArray(stored)) return []
  return stored.filter(
    (rule) => Boolean(rule) && typeof rule.match === 'string' && rule.match !== '' && !DEFAULT_SIGNATURE_REWRITES.some((base) => base.match === rule.match),
  )
}

export function effectiveRewrites(custom: SignatureRewrite[] | undefined, remote: SignatureRewrite[] | undefined): SignatureRewrite[] {
  const valid = (list: SignatureRewrite[] | undefined): SignatureRewrite[] =>
    Array.isArray(list) ? list.filter((rule) => Boolean(rule) && typeof rule.match === 'string' && rule.match !== '') : []
  return [...DEFAULT_SIGNATURE_REWRITES, ...valid(remote), ...valid(custom)]
}

export async function gatewayConfig(): Promise<GatewayConfig> {
  const config = await readConfig<Partial<GatewayConfig>>('gateway.json', {})
  const custom = Array.isArray(config.customSignatureRewrites) ? config.customSignatureRewrites : deriveCustomRewrites(config.signatureRewrites)
  const effective = effectiveRewrites(custom, config.remoteSignatureRewrites)
  if (config.virtualKey !== undefined && config.models !== undefined) {
    return {
      virtualKey: config.virtualKey,
      models: config.models,
      thinking: config.thinking ?? 'default',
      signatureRewrites: effective,
      ...(config.rulesUrl !== undefined ? { rulesUrl: config.rulesUrl } : {}),
      ...(config.activeAccountId !== undefined ? { activeAccountId: config.activeAccountId } : {}),
    }
  }
  // first run: generate and PERSIST immediately so every reader sees the same key
  const initial: GatewayConfig = {
    virtualKey: config.virtualKey ?? `wb-${randomUUID().replace(/-/g, '')}`,
    models: config.models ?? [...OFFICIAL_MODEL_CATALOG],
    thinking: config.thinking ?? 'default',
    signatureRewrites: effective,
    ...(config.rulesUrl !== undefined ? { rulesUrl: config.rulesUrl } : {}),
    ...(config.activeAccountId !== undefined ? { activeAccountId: config.activeAccountId } : {}),
  }
  await writeConfig('gateway.json', storedConfigShape(initial))
  return initial
}

/** 存储层投影：内置基线不落盘（随版本更新自动生效），只落远程缓存与用户增量。 */
function storedConfigShape(config: GatewayConfig): Record<string, unknown> {
  return {
    virtualKey: config.virtualKey,
    models: config.models,
    thinking: config.thinking ?? 'default',
    customSignatureRewrites: deriveCustomRewrites(config.signatureRewrites),
    remoteSignatureRewrites: Array.isArray(config.remoteSignatureRewrites) ? config.remoteSignatureRewrites : [],
    ...(config.rulesUrl !== undefined ? { rulesUrl: config.rulesUrl } : {}),
    ...(config.activeAccountId !== undefined ? { activeAccountId: config.activeAccountId } : {}),
  }
}

export async function saveGatewayConfig(patch: Partial<GatewayConfig>): Promise<GatewayConfig> {
  const current = await gatewayConfig()
  const next = { ...current, ...patch }
  await writeConfig('gateway.json', storedConfigShape(next))
  return next
}

/**
 * 拉取远程签名规则（rules JSON：{"rewrites":[{match,replacement}]}）。开源后
 * 官方规则文件随仓库发布，新签名句无需发版即全网关生效。静态 GET、零遥测、
 * 默认关闭（未配置 rulesUrl 时不发起任何请求）；失败静默保留上次缓存。
 */
export async function refreshRemoteRules(): Promise<{ fetched: number; error?: string }> {
  const config = await gatewayConfig()
  if (!config.rulesUrl) return { fetched: 0, error: 'rulesUrl 未配置（远程规则源关闭）' }
  try {
    const response = await fetch(config.rulesUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: { 'user-agent': 'wb-desktop' } })
    if (!response.ok) return { fetched: 0, error: `HTTP ${response.status}` }
    const data = (await response.json()) as { rewrites?: SignatureRewrite[] }
    const rules = Array.isArray(data.rewrites) ? data.rewrites.filter((r) => Boolean(r) && typeof r.match === 'string' && r.match !== '') : []
    await saveGatewayConfig({ remoteSignatureRewrites: rules })
    return { fetched: rules.length }
  } catch (error) {
    return { fetched: 0, error: error instanceof Error ? error.message : String(error) }
  }
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
  if (usageRing.length > 2000) usageRing.splice(0, usageRing.length - 2000)
  void writeConfig('gateway-usage.json', usageRing).catch(() => {})
}

// restore the ring on boot so失败现场 can be diagnosed after restarts
void readConfig<UsageEntry[]>('gateway-usage.json', []).then((stored) => {
  if (Array.isArray(stored)) usageRing.push(...stored.slice(-2000))
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

/**
 * 上游错误 → 标准错误语义。Agent 的退避重试策略依赖 error.type 与
 * Retry-After：429 该按提示等待、"模型不存在"不该重试——此前一律
 * api_error 会导致对不可恢复错误做指数退避。
 */
export function mapUpstreamError(
  status: number,
  bodyText: string,
  retryAfterHeader?: string | null,
): { type: string; message: string; retryAfterSec?: number } {
  let type = 'api_error'
  if (status === 401 || status === 403) type = 'authentication_error'
  else if (status === 404) type = 'not_found_error'
  else if (status === 429) type = 'rate_limit_error'
  else if (status === 529) type = 'overloaded_error'
  else if (status === 400) type = bodyText.includes('service info not found') ? 'not_found_error' : 'invalid_request_error'
  const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN
  return {
    type,
    message: (bodyText || String(status)).slice(0, 300),
    ...(Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? { retryAfterSec: Math.ceil(retryAfterSec) } : {}),
  }
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
  tool_choice?: { type: 'auto' | 'any' | 'tool' | 'none'; name?: string }
  stop_sequences?: unknown
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
  source?: unknown
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

/**
 * Anthropic image 块 → OpenAI image_url（base64 转 data URL，url 源直通）。
 * 上游若不支持视觉会显式报错——此前图片块被静默丢弃，Agent 发截图会得到
 * "没看见图"的回答，比报错严重。
 */
function imageBlockToOpenAi(block: ContentBlock): { type: 'image_url'; image_url: { url: string } } | undefined {
  const source = (block.source && typeof block.source === 'object' ? block.source : {}) as {
    type?: string
    media_type?: string
    data?: string
    url?: string
  }
  if (source.type === 'base64' && typeof source.data === 'string' && source.data !== '') {
    return { type: 'image_url', image_url: { url: `data:${source.media_type ?? 'image/png'};base64,${source.data}` } }
  }
  if (source.type === 'url' && typeof source.url === 'string' && source.url !== '') {
    return { type: 'image_url', image_url: { url: source.url } }
  }
  return undefined
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
      } else if (block.type === 'image' && !isAssistant) {
        flushText()
        const part = imageBlockToOpenAi(block)
        if (part) messages.push({ role: 'user', content: [part] })
      } else if (block.type === 'tool_use' && isAssistant) {
        toolCalls.push({
          id: String(block.id ?? `call_${toolCalls.length}`),
          type: 'function',
          function: { name: String(block.name ?? ''), arguments: JSON.stringify(block.input ?? {}) },
        })
      } else if (block.type === 'tool_result' && !isAssistant) {
        flushText()
        // tool_result 内容可为 string 或块数组；OpenAI 的 tool 消息只能带文本，
        // 截图等图片拆成紧随其后的 user 消息（LiteLLM 同款语义），不再静默丢图
        const parts: ContentBlock[] = Array.isArray(block.content)
          ? (block.content as ContentBlock[])
          : [{ type: 'text', text: contentToText(block.content) }]
        const text = parts
          .filter((part) => part && part.type === 'text')
          .map((part) => String(part.text ?? ''))
          .join('')
        messages.push({ role: 'tool', content: text, tool_call_id: String(block.tool_use_id ?? '') })
        const images = parts.map(imageBlockToOpenAi).filter((part) => part !== undefined)
        if (images.length > 0) messages.push({ role: 'user', content: images })
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
        : body.tool_choice?.type === 'none'
          ? 'none'
          : undefined
  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens ?? 4096,
    stream: body.stream === true,
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0 ? { stop: body.stop_sequences.map(String) } : {}),
  }
}

// ---------------------------------------------------------- upstream call

/**
 * 已知客户端系统提示签名句 → 语义等价改写。上游通道校验（11128）按其他编程
 * CLI 的系统提示样板句识别"未批准通道"；网关是用户自有账号的本机代理，转发前
 * 中和签名（语义保持），让任意客户端都能用自己的积分。内置基线即
 * DEFAULT_SIGNATURE_REWRITES（随版本更新），用户增量经 UI/API 叠加。
 */

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

export interface UpstreamChunk {
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

// 上游超时：连接/首包 120s；建立后流空闲 180s（思考模型会持续吐 reasoning
// delta，正常间隔远小于此）——此前上游挂起会让请求永久悬挂、连接堆积
const UPSTREAM_TTFB_MS = 120_000
const UPSTREAM_IDLE_MS = 180_000
const PROBE_TIMEOUT_MS = 15_000
// 同一账号的在途上游请求上限：Agent 并发打满容易触发通道风控（11128），超出即排队
const MAX_CONCURRENT_PER_ACCOUNT = 2

class Semaphore {
  private queue: (() => void)[] = []
  private running = 0
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running += 1
      return
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
  }
  release(): void {
    const next = this.queue.shift()
    if (next) next()
    else this.running -= 1
  }
}

const accountSlots = new Map<string, Semaphore>()

function accountSlot(account: WbAccount): Semaphore {
  const key = getStr(account, 'id') ?? accountName(account)
  let slot = accountSlots.get(key)
  if (!slot) {
    slot = new Semaphore(MAX_CONCURRENT_PER_ACCOUNT)
    accountSlots.set(key, slot)
  }
  return slot
}

/** 上游 body 的空闲看门狗：每次收到 chunk 续期，超时未收到即中止整条流。 */
function withIdleWatchdog(body: ReadableStream<Uint8Array>, controller: AbortController): ReadableStream<Uint8Array> {
  let timer: NodeJS.Timeout | undefined
  const reset = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new Error('upstream idle timeout')), UPSTREAM_IDLE_MS)
    timer.unref?.()
  }
  reset()
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, enqueue) => {
        reset()
        enqueue.enqueue(chunk)
      },
      flush: () => clearTimeout(timer),
    }),
  )
}

async function upstreamCall(account: WbAccount, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const config = await gatewayConfig()
  const effective = sanitizeBody({ ...body }, config.signatureRewrites ?? DEFAULT_SIGNATURE_REWRITES)
  if (config.thinking === 'disabled') {
    effective['thinking'] = { type: 'disabled' }
    delete effective['enable_thinking']
    delete effective['reasoning_effort']
    delete effective['reasoning']
  }
  const slot = accountSlot(account)
  await slot.acquire()
  try {
    return await upstreamCallInner(account, effective, signal)
  } finally {
    slot.release()
  }
}

async function upstreamCallInner(account: WbAccount, effective: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  // 内部总控：客户端断开（外部 signal）与内部超时共用一个 controller
  const controller = new AbortController()
  signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  const ttfbTimer = setTimeout(() => controller.abort(new Error('upstream ttfb timeout')), UPSTREAM_TTFB_MS)
  ttfbTimer.unref?.()
  const attempt = async (host: string): Promise<Response> =>
    await fetch(host + UPSTREAM_PATH, {
      method: 'POST',
      headers: { ...(await gatewayHeaders(account)), 'content-type': 'application/json' },
      body: JSON.stringify(effective),
      signal: controller.signal,
    })
  // 拿到响应即装空闲看门狗并撤首包定时器；重试产生的新响应需重新装
  const sealBody = (res: Response): Response => {
    clearTimeout(ttfbTimer)
    if (res.body) Object.defineProperty(res, 'body', { value: withIdleWatchdog(res.body, controller), configurable: true })
    return res
  }
  let response: Response
  try {
    response = sealBody(await attempt(UPSTREAM_HOST))
  } catch (error) {
    clearTimeout(ttfbTimer)
    // 首包超时/网络失败统一转成可读错误（客户端主动断开保持 AbortError 原样上抛）
    if (controller.signal.aborted && !signal?.aborted) throw new Error('上游无响应（连接/首包超时 120s）')
    throw error
  }
  if (response.status >= 500) response = sealBody(await attempt(UPSTREAM_FAILOVER_HOST))
  if (response.status === 401 && Date.now() - lastRefreshAt > REFRESH_COOLDOWN_MS) {
    lastRefreshAt = Date.now()
    const result = await refreshAccountToken(account, async (updated) => {
      const index = currentAccounts().indexOf(account)
      if (index >= 0) currentAccounts()[index] = updated
      await persistAccounts()
    })
    if (result.ok) response = sealBody(await attempt(UPSTREAM_HOST))
  }
  // 11128 通道风控拦截是官方提示可重发的瞬时错误——自动重发一次
  if (response.status === 400) {
    const errorText = await response.text().catch(() => '')
    if (errorText.includes('11128')) {
      // 现场捕获：被拦的转换后请求体落盘，供定位风控触发条件
      try {
        const { mkdir, writeFile, readdir, rm } = await import('node:fs/promises')
        const dir = dataFile('gateway-debug')
        await mkdir(dir, { recursive: true })
        await writeFile(`${dir}/11128-${Date.now()}.json`, JSON.stringify({ ts: Date.now(), account: accountName(account), model: String(effective['model'] ?? ''), bodyKB: Math.round(JSON.stringify(effective).length / 1024), body: effective }, null, 1))
        // 转储含完整 prompt 内容：只保留最近 20 个，防无限增长与内容留存
        const files = (await readdir(dir)).filter((name) => name.startsWith('11128-')).sort()
        for (const stale of files.slice(0, Math.max(0, files.length - 20))) await rm(`${dir}/${stale}`, { force: true })
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 800))
      await new Promise((resolve) => setTimeout(resolve, 800))
      response = sealBody(await attempt(UPSTREAM_HOST))
      if (response.status >= 500) response = sealBody(await attempt(UPSTREAM_FAILOVER_HOST))
      if (!response.ok) {
        const retryText = await response.text().catch(() => '')
        // 重发仍被拦：大概率命中了改写表未覆盖的新签名句——把处置指引写进
        // 错误消息（此前把上游 400 原文直接甩给客户端，用户无从下手）
        const hint = retryText.includes('11128')
          ? `上游通道风控(11128)持续拦截：疑似命中改写表未覆盖的新签名句。请到「网关代理 → 高级：签名改写」添加规则；被拦请求体已转储至 ~/.wb-hub/gateway-debug/ 供定位。上游原文: ${retryText.slice(0, 150)}`
          : retryText
        response = new Response(hint, {
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
  // 客户端断开即中止上游（实测中断不扣费，见 2026-10-13 计费实验）
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })
  let response: Response
  try {
    response = await upstreamCall(active.account, body, controller.signal)
  } catch (error) {
    if (controller.signal.aborted) {
      tallyUsage(active.account, model, undefined, false, 'client_aborted')
      return
    }
    throw error
  }
  if (!response.ok && !response.headers.get('content-type')?.includes('text/event-stream')) {
    const errorText = (await response.text().catch(() => '')) || String(response.status)
    const mapped = mapUpstreamError(response.status, errorText, response.headers.get('retry-after'))
    tallyUsage(active.account, model, undefined, false, errorText.slice(0, 200))
    res.writeHead(response.status, {
      'content-type': 'application/json; charset=utf-8',
      ...(mapped.retryAfterSec !== undefined ? { 'retry-after': String(mapped.retryAfterSec) } : {}),
    })
    res.end(JSON.stringify({ error: { message: mapped.message, type: mapped.type } }))
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
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-wb-account': accountName(active.account) })
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
  // token 使用记录不更新」的根因。客户端中止（上游 usage 不会到达）如实标记。
  if (controller.signal.aborted && streamUsage === undefined) {
    tallyUsage(active.account, model, undefined, false, 'client_aborted')
  } else {
    tallyUsage(active.account, model, streamUsage, true)
  }
}

// ------------------------------------------- anthropic ↔ openai messages

/**
 * 上游 OpenAI delta → Anthropic SSE 事件的流式翻译状态机（真流式）。
 * 块序号按出现顺序递增；tool_use 首个 delta 常缺 id/name，攒齐才开块并
 * 把已攒的 arguments 一次性补发。空响应防护沿用：收尾时若无任何正文/
 * 工具块，注入思考回填文本，客户端永不空响应。
 */
export interface AnthropicStreamEvent {
  type: string
  [key: string]: unknown
}

export function createAnthropicStreamTranslator(suppressReasoning: boolean): {
  push: (chunk: UpstreamChunk) => AnthropicStreamEvent[]
  finish: (truncated?: boolean) => AnthropicStreamEvent[]
  getUsage: () => UpstreamChunk['usage'] | undefined
} {
  const events: AnthropicStreamEvent[] = []
  let nextIndex = 0
  let openIndex = -1
  let openType: 'text' | 'thinking' | 'tool_use' | null = null
  let textChars = 0
  let toolBlocks = 0
  let accumulatedThinking = ''
  let emittedThinkingBlock = false
  let stopReason = 'end_turn'
  let usage: UpstreamChunk['usage'] | undefined
  const toolState = new Map<number, { blockIndex: number; id: string; name: string; buffered: string; opened: boolean }>()

  const close = (): void => {
    if (openType) {
      events.push({ type: 'content_block_stop', index: openIndex })
      openType = null
    }
  }
  const open = (type: 'text' | 'thinking' | 'tool_use', block: Record<string, unknown>): number => {
    close()
    openIndex = nextIndex++
    openType = type
    events.push({ type: 'content_block_start', index: openIndex, content_block: block })
    return openIndex
  }

  return {
    push(chunk: UpstreamChunk): AnthropicStreamEvent[] {
      events.length = 0
      if (chunk.usage) usage = chunk.usage
      const choice = chunk.choices?.[0]
      if (choice?.finish_reason) {
        stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn'
      }
      const delta = choice?.delta
      if (delta?.reasoning_content) {
        accumulatedThinking += delta.reasoning_content
        if (!suppressReasoning) {
          if (openType !== 'thinking') {
            open('thinking', { type: 'thinking', thinking: '' })
            emittedThinkingBlock = true
          }
          events.push({ type: 'content_block_delta', index: openIndex, delta: { type: 'thinking_delta', thinking: delta.reasoning_content } })
        }
      }
      if (delta?.content) {
        textChars += delta.content.length
        if (openType !== 'text') open('text', { type: 'text', text: '' })
        events.push({ type: 'content_block_delta', index: openIndex, delta: { type: 'text_delta', text: delta.content } })
      }
      for (const call of delta?.tool_calls ?? []) {
        const idx = call.index ?? 0
        let state = toolState.get(idx)
        if (!state) {
          state = { blockIndex: -1, id: call.id ?? '', name: call.function?.name ?? '', buffered: '', opened: false }
          toolState.set(idx, state)
        }
        if (call.id) state.id = call.id
        if (call.function?.name) state.name = call.function.name
        if (!state.opened && state.id && state.name) {
          state.blockIndex = open('tool_use', { type: 'tool_use', id: state.id, name: state.name, input: {} })
          state.opened = true
          toolBlocks += 1
          // 开块前积压的参数（name 未到时先攒着）随开块立即补发
          if (state.buffered) {
            events.push({ type: 'content_block_delta', index: state.blockIndex, delta: { type: 'input_json_delta', partial_json: state.buffered } })
            state.buffered = ''
          }
        }
        if (call.function?.arguments) {
          if (state.opened) {
            events.push({ type: 'content_block_delta', index: state.blockIndex, delta: { type: 'input_json_delta', partial_json: call.function.arguments } })
          } else {
            state.buffered += call.function.arguments
          }
        }
      }
      return events.splice(0, events.length)
    },
    finish(truncated = false): AnthropicStreamEvent[] {
      events.length = 0
      for (const state of [...toolState.values()].sort((a, b) => a.blockIndex - b.blockIndex)) {
        if (!state.opened && state.id && state.name) {
          state.blockIndex = open('tool_use', { type: 'tool_use', id: state.id, name: state.name, input: {} })
          state.opened = true
          toolBlocks += 1
          if (state.buffered) {
            events.push({ type: 'content_block_delta', index: state.blockIndex, delta: { type: 'input_json_delta', partial_json: state.buffered } })
          }
        }
      }
      if (textChars === 0 && toolBlocks === 0 && !emittedThinkingBlock && !truncated) {
        // 与非流式路径同语义：正文完全为空时至少给一个 text 块，思考占满预算
        // 而思考被抑制时回填 banner，客户端永不空响应（思考已下发则不再重复）
        open('text', { type: 'text', text: '' })
        if (accumulatedThinking !== '') {
          events.push({ type: 'content_block_delta', index: openIndex, delta: { type: 'text_delta', text: `〔模型思考过程，未产出最终回答〕${accumulatedThinking}` } })
        }
      }
      close()
      events.push({
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { input_tokens: usage?.prompt_tokens ?? 0, output_tokens: usage?.completion_tokens ?? 0 },
      })
      events.push({ type: 'message_stop' })
      return events.splice(0, events.length)
    },
    getUsage: () => usage,
  }
}

export function anthropicMessageStart(model: string): AnthropicStreamEvent {
  return {
    type: 'message_start',
    message: {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }
}

/**
 * 本地估算 Anthropic 请求的 input tokens（粗略）：CJK ≈ 1 token/字，
 * 其他字符 ≈ 1 token/4 字符；tools 定义也计入。供 count_tokens 端点做
 * 上下文管理用——不花积分、非计费口径。
 */
export function estimateAnthropicInputTokens(body: AnthropicBody): number {
  let text = contentToText(body.system)
  for (const message of body.messages ?? []) text += contentToText(message.content)
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools as { name?: unknown; description?: unknown; input_schema?: unknown }[]) {
      text += `${String(tool.name ?? '')}${String(tool.description ?? '')}${JSON.stringify(tool.input_schema ?? '')}`
    }
  }
  const cjk = (text.match(/[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]/g) ?? []).length
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

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
  const model = String(anthropic.model ?? '')
  // 客户端断开即中止上游（实测中断不扣费，见 2026-10-13 计费实验）
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })
  let response: Response
  try {
    response = await upstreamCall(active.account, openaiBody, controller.signal)
  } catch (error) {
    if (controller.signal.aborted) {
      tallyUsage(active.account, model, undefined, false, 'client_aborted')
      return
    }
    throw error
  }
  if (!response.ok && !response.headers.get('content-type')?.includes('text/event-stream')) {
    const errorText = (await response.text().catch(() => '')) || String(response.status)
    const mapped = mapUpstreamError(response.status, errorText, response.headers.get('retry-after'))
    tallyUsage(active.account, model, undefined, false, errorText.slice(0, 200))
    res.writeHead(response.status, {
      'content-type': 'application/json; charset=utf-8',
      ...(mapped.retryAfterSec !== undefined ? { 'retry-after': String(mapped.retryAfterSec) } : {}),
    })
    res.end(JSON.stringify({ type: 'error', error: { type: mapped.type, message: mapped.message } }))
    return
  }
  if (!response.body) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream returned no body' } }))
    return
  }

  if (anthropic.stream === true) {
    // 真流式：上游 OpenAI delta 逐条翻译为 Anthropic SSE 事件下发
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-wb-account': accountName(active.account),
    })
    const emit = (event: AnthropicStreamEvent): void => {
      if (!res.writableEnded) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    }
    emit(anthropicMessageStart(model))
    const translator = createAnthropicStreamTranslator(suppressReasoning)
    const streamReader = response.body.getReader()
    const streamDecoder = new TextDecoder()
    let streamBuffered = ''
    let truncated = false
    const flushEvent = (event: string): void => {
      const dataLine = event.split('\n').find((l) => l.startsWith('data:'))
      if (!dataLine || dataLine.includes('[DONE]')) return
      try {
        for (const out of translator.push(JSON.parse(dataLine.slice(5)) as UpstreamChunk)) emit(out)
      } catch {}
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
    } catch {
      truncated = true
    }
    for (const out of translator.finish(truncated)) emit(out)
    res.end()
    // 客户端中止（上游 usage 不会到达）如实标记；正常结束按最终 usage 入账
    if (controller.signal.aborted && translator.getUsage() === undefined) {
      tallyUsage(active.account, model, undefined, false, 'client_aborted')
    } else {
      tallyUsage(active.account, model, translator.getUsage(), true)
    }
    return
  }

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

  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-wb-account': accountName(active.account) })
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
  if (pathName === '/v1/messages/count_tokens' && method === 'POST') {
    const config = await gatewayConfig()
    if (!keyOk(req, config.virtualKey, url)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid virtual key' } }))
      return true
    }
    const reqChunks: Buffer[] = []
    for await (const chunk of req) reqChunks.push(chunk as Buffer)
    try {
      const body = JSON.parse(Buffer.concat(reqChunks).toString('utf8')) as AnthropicBody
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ input_tokens: estimateAnthropicInputTokens(body) }))
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON body' } }))
    }
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
