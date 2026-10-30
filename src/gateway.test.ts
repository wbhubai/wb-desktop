import { describe, expect, it } from 'vitest'
import {
  anthropicMessageStart,
  anthropicToOpenAi,
  buildDegradedBody,
  createAnthropicStreamTranslator,
  DEFAULT_SIGNATURE_REWRITES,
  deriveCustomRewrites,
  effectiveRewrites,
  estimateAnthropicInputTokens,
  learnModelInCatalog,
  mapUpstreamError,
  mergeModelCatalogs,
  migrateModelCatalog,
  parseEnterpriseModels,
  parseModelCatalog,
  sanitizeBody,
  summarizeUsage,
} from './gateway.ts'
import type { AnthropicBody, ModelInfo, UpstreamChunk, UsageEntry } from './gateway.ts'

function chunk(partial: Partial<UpstreamChunk>): UpstreamChunk {
  return partial as UpstreamChunk
}

function textDelta(text: string, finish?: string): UpstreamChunk {
  return chunk({ choices: [{ delta: { content: text }, ...(finish ? { finish_reason: finish } : {}) }] })
}

function types(events: { type: string }[]): string[] {
  return events.map((event) => event.type)
}

describe('anthropic stream translator', () => {
  it('message_start carries role/model and empty content', () => {
    const start = anthropicMessageStart('hy3')
    expect(start.type).toBe('message_start')
    const message = start.message as Record<string, unknown>
    expect(message.role).toBe('assistant')
    expect(message.model).toBe('hy3')
    expect(message.content).toEqual([])
    expect(message.stop_reason).toBeNull()
  })

  it('text stream: one text block, deltas, stop and usage in message_delta', () => {
    const t = createAnthropicStreamTranslator(false)
    expect(types(t.push(textDelta('he')))).toEqual(['content_block_start', 'content_block_delta'])
    expect(types(t.push(textDelta('llo', 'stop')))).toEqual(['content_block_delta'])
    const tail = t.finish()
    expect(types(tail)).toEqual(['content_block_stop', 'message_delta', 'message_stop'])
    const messageDelta = tail[1] as { delta: { stop_reason: string }; usage: { input_tokens: number; output_tokens: number } }
    expect(messageDelta.delta.stop_reason).toBe('end_turn')
    expect(messageDelta.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  })

  it('usage from final chunk lands in message_delta', () => {
    const t = createAnthropicStreamTranslator(false)
    t.push(chunk({ choices: [{ delta: { content: 'a' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }))
    const tail = t.finish()
    const messageDelta = tail[1] as { usage: { input_tokens: number; output_tokens: number } }
    expect(messageDelta.usage).toEqual({ input_tokens: 7, output_tokens: 3 })
    expect(t.getUsage()?.prompt_tokens).toBe(7)
  })

  it('thinking then text: separate blocks with incrementing indices', () => {
    const t = createAnthropicStreamTranslator(false)
    const first = t.push(chunk({ choices: [{ delta: { reasoning_content: '想' } }] }))
    expect(types(first)).toEqual(['content_block_start', 'content_block_delta'])
    expect((first[1] as { delta: { type: string } }).delta.type).toBe('thinking_delta')
    const second = t.push(textDelta('答'))
    expect(types(second)).toEqual(['content_block_stop', 'content_block_start', 'content_block_delta'])
    expect((second[1] as { content_block: { type: string; index?: number } }).content_block.type).toBe('text')
    expect((second[1] as { index: number }).index).toBe(1)
    const tail = t.finish()
    expect(types(tail)).toEqual(['content_block_stop', 'message_delta', 'message_stop'])
  })

  it('suppressReasoning drops thinking deltas, text path unaffected', () => {
    const t = createAnthropicStreamTranslator(true)
    expect(t.push(chunk({ choices: [{ delta: { reasoning_content: '深度思考' } }] }))).toEqual([])
    expect(t.push(textDelta('正文'))).toHaveLength(2)
    t.finish()
  })

  it('thinking-only stream: thinking block closed, no duplicate banner', () => {
    const t = createAnthropicStreamTranslator(false)
    t.push(chunk({ choices: [{ delta: { reasoning_content: '只想不说' } }], usage: { prompt_tokens: 1, completion_tokens: 4 } }))
    const tail = t.finish()
    // 思考块已真实下发给客户端，收尾只关闭它，不再注入重复的 banner
    expect(types(tail)).toEqual(['content_block_stop', 'message_delta', 'message_stop'])
  })

  it('suppressed thinking-only stream degrades to banner text block', () => {
    const t = createAnthropicStreamTranslator(true)
    t.push(chunk({ choices: [{ delta: { reasoning_content: '只想不说' } }], usage: { prompt_tokens: 1, completion_tokens: 4 } }))
    const tail = t.finish()
    expect(types(tail)).toEqual(['content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
    const banner = tail[1] as { delta: { text: string } }
    expect(banner.delta.text).toContain('〔模型思考过程，未产出最终回答〕只想不说')
  })

  it('tool call: block opens with id/name, arguments stream as input_json_delta', () => {
    const t = createAnthropicStreamTranslator(false)
    const first = t.push(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] }))
    expect(types(first)).toEqual(['content_block_start', 'content_block_delta'])
    const blockStart = first[0] as { index: number; content_block: { type: string; id: string; name: string; input: unknown } }
    expect(blockStart.content_block).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'read_file', input: {} })
    expect((first[1] as { delta: { partial_json: string } }).delta.partial_json).toBe('{"pa')
    const second = t.push(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th: 1}' } }] } }] }))
    expect((second[0] as { delta: { partial_json: string } }).delta.partial_json).toBe('th: 1}')
    t.push(chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
    const tail = t.finish()
    const messageDelta = tail[1] as { delta: { stop_reason: string } }
    expect(messageDelta.delta.stop_reason).toBe('tool_use')
  })

  it('tool call with late name: buffered arguments flush when the block opens', () => {
    const t = createAnthropicStreamTranslator(false)
    // 首个 delta 带 arguments 但 name 未到：不能开块，也不能丢参数
    expect(t.push(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: '', arguments: '{"x"' } }] } }] }))).toEqual([])
    const second = t.push(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'run' } }] } }] }))
    // name 到达即开块，并把先前积压的参数立即补发
    expect(types(second)).toEqual(['content_block_start', 'content_block_delta'])
    expect((second[1] as { delta: { partial_json: string } }).delta.partial_json).toBe('{"x"')
    const third = t.push(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] }))
    expect((third[0] as { delta: { partial_json: string } }).delta.partial_json).toBe('}')
  })

  it('stop reason length maps to max_tokens', () => {
    const t = createAnthropicStreamTranslator(false)
    t.push(textDelta('abc', 'length'))
    const tail = t.finish()
    expect((tail[1] as { delta: { stop_reason: string } }).delta.stop_reason).toBe('max_tokens')
  })

  it('truncated finish does not fabricate content', () => {
    const t = createAnthropicStreamTranslator(false)
    const tail = t.finish(true)
    expect(types(tail)).toEqual(['message_delta', 'message_stop'])
  })
})

describe('anthropicToOpenAi image & params mapping', () => {
  it('user image block maps to image_url data URL instead of being dropped', () => {
    const body = {
      model: 'hy4-preview',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这是什么？' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      }],
    } as unknown as AnthropicBody
    const out = anthropicToOpenAi(body)
    expect(out.messages).toContainEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    })
  })

  it('tool_result images split into a following user message, text stays in tool message', () => {
    const body = {
      model: 'hy3',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 't1',
          content: [
            { type: 'text', text: '截图如下' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BB' } },
          ],
        }],
      }],
    } as unknown as AnthropicBody
    const out = anthropicToOpenAi(body)
    expect(out.messages).toContainEqual({ role: 'tool', content: '截图如下', tool_call_id: 't1' })
    expect(out.messages).toContainEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BB' } }],
    })
  })

  it('tool_choice none maps to none (previously silently became auto)', () => {
    const body = {
      model: 'hy3',
      tool_choice: { type: 'none' },
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as AnthropicBody
    expect(anthropicToOpenAi(body).tool_choice).toBe('none')
  })

  it('stop_sequences maps to stop', () => {
    const body = {
      model: 'hy3',
      stop_sequences: ['END', 'STOP'],
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as AnthropicBody
    expect(anthropicToOpenAi(body).stop).toEqual(['END', 'STOP'])
  })
})

describe('mapUpstreamError', () => {
  it('maps statuses to standard error types', () => {
    expect(mapUpstreamError(401, 'x').type).toBe('authentication_error')
    expect(mapUpstreamError(404, 'x').type).toBe('not_found_error')
    expect(mapUpstreamError(429, 'x').type).toBe('rate_limit_error')
    expect(mapUpstreamError(529, 'x').type).toBe('overloaded_error')
    expect(mapUpstreamError(502, 'x').type).toBe('api_error')
    expect(mapUpstreamError(400, 'service info not found').type).toBe('not_found_error')
    expect(mapUpstreamError(400, 'bad field').type).toBe('invalid_request_error')
  })

  it('passes retry-after through as seconds', () => {
    expect(mapUpstreamError(429, 'x', '12').retryAfterSec).toBe(12)
    expect(mapUpstreamError(429, 'x').retryAfterSec).toBeUndefined()
    // HTTP-date 等无法解析的值不透传
    expect(mapUpstreamError(429, 'x', 'Wed, 21 Oct 2026 07:28:00 GMT').retryAfterSec).toBeUndefined()
  })
})

describe('estimateAnthropicInputTokens', () => {
  it('counts CJK roughly 1 token per char', () => {
    const body = { model: 'hy3', messages: [{ role: 'user', content: '你好世界再见世界' }] } as unknown as AnthropicBody
    expect(estimateAnthropicInputTokens(body)).toBe(8)
  })

  it('counts latin roughly 1 token per 4 chars and includes system', () => {
    const body = {
      model: 'hy3',
      system: 'abcdefgh', // 8 latin → 2
      messages: [{ role: 'user', content: 'ijklmnop' }], // 8 latin → 2
    } as unknown as AnthropicBody
    expect(estimateAnthropicInputTokens(body)).toBe(4)
  })
})

describe('signature rewrite storage migration', () => {
  it('old full snapshot migrates: builtin entries filtered out, customs kept', () => {
    const stored = [
      { match: 'Main branch (you will usually use this for PRs): main', replacement: 'Main branch: main' },
      { match: 'CUSTOM-1', replacement: 'custom-1' },
    ]
    expect(deriveCustomRewrites(stored)).toEqual([{ match: 'CUSTOM-1', replacement: 'custom-1' }])
  })

  it('empty/undefined stored yields no custom', () => {
    expect(deriveCustomRewrites(undefined)).toEqual([])
    expect(deriveCustomRewrites([])).toEqual([])
  })

  it('effective table always carries the builtin baseline plus customs', () => {
    const effective = effectiveRewrites([{ match: 'X', replacement: 'Y' }], undefined)
    expect(effective.length).toBeGreaterThanOrEqual(1)
    expect(effective.some((r) => r.match === 'X')).toBe(true)
    // 应用更新内置表后，零配置用户自动获得新基线（含 11128 反自指改写）
    expect(effective.some((r) => r.match === '11128')).toBe(true)
    expect(effective.some((r) => r.match === 'Main branch (you will usually use this for PRs): main')).toBe(true)
  })

  it('remote rules sit between builtin baseline and user customs', () => {
    const effective = effectiveRewrites([{ match: 'USER', replacement: 'u' }], [{ match: 'REMOTE', replacement: 'r' }])
    const ids = effective.map((r) => r.match)
    expect(ids.indexOf('REMOTE')).toBeGreaterThan(0)
    expect(ids.indexOf('REMOTE')).toBeLessThan(ids.indexOf('USER'))
    expect(ids.lastIndexOf('USER')).toBe(ids.length - 1)
  })

  it('reset (empty desired list) derives to empty custom → builtin baseline only', () => {
    const effective = effectiveRewrites(deriveCustomRewrites([]), undefined)
    expect(effective).toEqual(effectiveRewrites([], undefined))
  })
})

describe('model catalog', () => {
  it('parseModelCatalog: credits 解析倍率，discounts 映射标签', () => {
    const parsed = parseModelCatalog({
      models: [
        { id: 'hy4-preview', name: 'Hy4 preview', credits: 'x0.29 credits', supportsImages: true, supportsToolCall: true },
        { id: 'hy3', name: 'Hy3', credits: 'x0.00 credits' },
        { id: 'hunyuan-image-alpha', name: 'Hunyuan Image Alpha' },
      ],
      discounts: [
        { badge: { label: '夜间免费' }, modelIds: ['hy4-preview'] },
        { badge: { label: '限时免费' }, modelIds: ['hy3', 'hy4-preview'] },
        { badge: { label: '无模型ID' }, modelIds: [] },
      ],
    })
    expect(parsed).toHaveLength(3)
    const hy4 = parsed.find((m) => m.id === 'hy4-preview')!
    expect(hy4.multiplier).toBe(0.29)
    expect(hy4.tags).toEqual(['夜间免费', '限时免费'])
    expect(hy4.images).toBe(true)
    const hy3 = parsed.find((m) => m.id === 'hy3')!
    expect(hy3.multiplier).toBe(0)
    const image = parsed.find((m) => m.id === 'hunyuan-image-alpha')!
    expect(image.multiplier).toBeUndefined()
    expect(image.source).toBe('remote')
  })

  it('migrateModelCatalog: 旧 models 迁移为 manual，兜底目录补缺，不重复', () => {
    const catalog = migrateModelCatalog([{ id: 'kimi-k3', source: 'learned', lastSeenAt: 1 }], ['glm-5.3'])
    const ids = catalog.map((m) => m.id)
    expect(ids).toContain('kimi-k3')
    expect(ids).toContain('glm-5.3')
    expect(ids.filter((x) => x === 'glm-5.3')).toHaveLength(1)
    expect(catalog.find((m) => m.id === 'kimi-k3')?.source).toBe('learned')
    // OFFICIAL_MODEL_CATALOG 兜底全部进入
    expect(ids.length).toBeGreaterThanOrEqual(7)
  })

  it('learnModelInCatalog: 已存在只刷新时间，不存在则 learned 追加', () => {
    const catalog: ModelInfo[] = [{ id: 'hy3', source: 'remote', lastSeenAt: 100 }]
    learnModelInCatalog(catalog, 'hy3', 200)
    expect(catalog.find((m) => m.id === 'hy3')?.lastSeenAt).toBe(200)
    expect(catalog.find((m) => m.id === 'hy3')?.source).toBe('remote')
    learnModelInCatalog(catalog, 'kimi-k3', 300)
    expect(catalog.find((m) => m.id === 'kimi-k3')).toMatchObject({ source: 'learned', lastSeenAt: 300 })
    expect(learnModelInCatalog(catalog, '  ', 400)).toHaveLength(2)
  })
})

describe('dual-endpoint catalog', () => {
  it('parseEnterpriseModels: 无后缀 credits 与上下文字段', () => {
    const parsed = parseEnterpriseModels({
      models: [
        { id: 'auto', name: 'Auto', maxInputTokens: 256000, maxOutputTokens: 32000, supportsImages: true, supportsToolCall: true, descriptionZh: '自动匹配最优模型' },
        { id: 'glm-5.3-flash', credits: 'x0.06', maxInputTokens: 1000000 },
      ],
    })
    expect(parsed.find((m) => m.id === 'auto')).toMatchObject({ contextWindow: 256000, maxOutputTokens: 32000, description: '自动匹配最优模型' })
    expect(parsed.find((m) => m.id === 'glm-5.3-flash')?.multiplier).toBe(0.06)
  })

  it('mergeModelCatalogs: 主路权威，补路只填缺失', () => {
    const merged = mergeModelCatalogs(
      [{ id: 'hy3', source: 'remote', multiplier: 0 }],
      [{ id: 'hy3', source: 'remote', multiplier: 9.9 }, { id: 'auto', source: 'remote', contextWindow: 256000 }],
    )
    expect(merged).toHaveLength(2)
    expect(merged.find((m) => m.id === 'hy3')?.multiplier).toBe(0)
    expect(merged.find((m) => m.id === 'auto')?.contextWindow).toBe(256000)
  })
})


describe('11128 defense layers', () => {
  it('sanitizeBody rewrites the self-referential 11128 literal in messages', () => {
    const body = { model: 'hy3', messages: [{ role: 'user', content: '错误码 11128 是什么意思？' }] } as unknown as Record<string, unknown>
    const out = sanitizeBody(body, DEFAULT_SIGNATURE_REWRITES)
    const content = (out.messages as { content: string }[])[0]!.content
    expect(content).not.toContain('11128')
    expect(content).toContain('11-128')
  })

  it('stripHeaderFingerprints: key-value segment removed, bare name abbreviated, cc_ kv loop-cleaned', () => {
    const body = {
      model: 'hy3',
      messages: [{
        role: 'user',
        content: '配置示例：x-anthropic-billing-header: abc123; 以及 cc_version=1.2.3; cc_entrypoint=cli; 还有裸键名 x-anthropic-billing-header 引用',
      }],
    } as unknown as Record<string, unknown>
    const out = sanitizeBody(body, DEFAULT_SIGNATURE_REWRITES)
    const content = (out.messages as { content: string }[])[0]!.content
    expect(content).not.toContain('abc123')
    expect(content).not.toContain('cc_version=1.2.3')
    expect(content).not.toContain('cc_entrypoint=cli')
    expect(content).toContain('x-anthropic-billing-hdr')
    expect(content).not.toMatch(/x-anthropic-billing-header/i)
  })

  it('known signature sentences rewrite by one word', () => {
    const body = {
      model: 'hy3',
      messages: [{ role: 'system', content: "You are Claude Code, Anthropic's official CLI for Claude. Main branch (you will usually use this for PRs): main" }],
    } as unknown as Record<string, unknown>
    const out = sanitizeBody(body, DEFAULT_SIGNATURE_REWRITES)
    const content = (out.messages as { content: string }[])[0]!.content
    expect(content).toContain("official CLI tool for Claude")
    expect(content).toContain('Default branch (you will usually use this for PRs): main')
    expect(content).not.toContain('Main branch (you will usually use this for PRs)')
  })

  it('buildDegradedBody drops system/developer and injects one neutral system', () => {
    const body = {
      model: 'hy3',
      messages: [
        { role: 'system', content: 'client system prompt' },
        { role: 'developer', content: 'dev prompt' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    } as unknown as Record<string, unknown>
    const out = buildDegradedBody(body)
    const messages = out.messages as { role: string; content: string }[]
    expect(messages).toHaveLength(3)
    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content).toContain('helpful assistant')
    expect(messages[1]!.role).toBe('user')
    expect(messages[2]!.role).toBe('assistant')
  })
})

describe('usage summary', () => {
  function at(month: number, day: number, hour: number, minute: number): number {
    return new Date(2026, month - 1, day, hour, minute, 0, 0).getTime()
  }
  const now = at(10, 30, 12, 0)
  function entry(ts: number, model: string, credit: number | null, ok = true): UsageEntry {
    return { ts, account: 'owner@example.com', model, promptTokens: 10, completionTokens: 5, credit, ok }
  }

  it('今日积分只累加本地当天，与累计积分并存', () => {
    const summary = summarizeUsage([
      entry(at(10, 29, 23, 55), 'glm-5.3-flash', 2.5),
      entry(at(10, 30, 0, 5), 'glm-5.3-flash', 1.25),
      entry(at(10, 30, 9, 0), 'hy3', 0.5),
    ], now)
    expect(summary.credit).toBe(4.25)
    const glm = summary.byModel.find((row) => row.model === 'glm-5.3-flash')!
    expect(glm.requests).toBe(2)
    expect(glm.credit).toBe(3.75)
    expect(glm.todayRequests).toBe(1)
    expect(glm.todayCredit).toBe(1.25)
    expect(summary.byModel.find((row) => row.model === 'hy3')!.todayCredit).toBe(0.5)
  })

  it('零点整算今天，前一日最后一分钟算昨天', () => {
    const row = summarizeUsage([
      entry(at(10, 29, 23, 59), 'hy3', 1),
      entry(at(10, 30, 0, 0), 'hy3', 2),
    ], now).byModel[0]!
    expect(row.credit).toBe(3)
    expect(row.todayRequests).toBe(1)
    expect(row.todayCredit).toBe(2)
  })

  it('credit 未知的失败请求计入请求数但不抵扣积分合计', () => {
    const summary = summarizeUsage([
      entry(at(10, 30, 10, 0), 'hy3', 0.3),
      entry(at(10, 30, 10, 1), 'hy3', null, false),
    ], now)
    const row = summary.byModel[0]!
    expect(summary.credit).toBeNull()
    expect(summary.errors).toBe(1)
    expect(row.todayRequests).toBe(2)
    expect(row.todayCredit).toBeCloseTo(0.3)
  })

  it('空台账不产生模型行', () => {
    const summary = summarizeUsage([], now)
    expect(summary.requests).toBe(0)
    expect(summary.byModel).toEqual([])
  })
})
