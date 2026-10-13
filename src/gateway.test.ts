import { describe, expect, it } from 'vitest'
import { anthropicMessageStart, createAnthropicStreamTranslator } from './gateway.ts'
import type { UpstreamChunk } from './gateway.ts'

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
