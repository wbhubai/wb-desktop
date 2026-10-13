import { describe, expect, it } from 'vitest'
import {
  anthropicMessageStart,
  anthropicToOpenAi,
  createAnthropicStreamTranslator,
  deriveCustomRewrites,
  effectiveRewrites,
  estimateAnthropicInputTokens,
  mapUpstreamError,
} from './gateway.ts'
import type { AnthropicBody, UpstreamChunk } from './gateway.ts'

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
    const effective = effectiveRewrites([{ match: 'X', replacement: 'Y' }])
    expect(effective.length).toBeGreaterThanOrEqual(1)
    expect(effective.some((r) => r.match === 'X')).toBe(true)
    // 应用更新内置表后，零配置用户自动获得新基线
    expect(effective[0]).toMatchObject({ match: 'Main branch (you will usually use this for PRs): main' })
  })

  it('reset (empty desired list) derives to empty custom → builtin baseline only', () => {
    const effective = effectiveRewrites(deriveCustomRewrites([]))
    expect(effective).toEqual(effectiveRewrites([]))
  })
})
