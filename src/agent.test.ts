import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createContext } from './context.js'
import { createTool } from './tool.js'
import { runAgent, MaxStepsError } from './agent.js'
import type { Provider, GenerateResult, Message, ToolSpec } from './types.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a mock provider from a sequence of responses */
function mockProvider(
  responses: GenerateResult[],
): Provider & { callCount: number; lastMessages: Message[] } {
  let idx = 0
  const p = {
    callCount: 0,
    lastMessages: [] as Message[],
    async generate(params: {
      messages: Message[]
      tools?: ToolSpec[]
      signal?: AbortSignal
    }) {
      p.callCount++
      p.lastMessages = params.messages
      const r = responses[idx]
      if (!r) throw new Error('Mock provider exhausted')
      idx++
      return r
    },
  }
  return p
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('runAgent', () => {
  it('returns immediately on text-only response', async () => {
    const provider = mockProvider([
      { content: 'Hello!' },
    ])
    const ctx = createContext()
    ctx.push('Hi')

    const result = await runAgent({
      ctx,
      provider,
      instruction: 'Be helpful',
      tools: [],
    })

    assert.equal(result.response, 'Hello!')
    assert.equal(result.steps, 1)
    assert.equal(provider.callCount, 1)
  })

  it('instruction is sent as system message but NOT stored in context', async () => {
    const provider = mockProvider([
      { content: 'Done.' },
    ])
    const ctx = createContext()
    ctx.push('Hi')

    await runAgent({
      ctx,
      provider,
      instruction: 'Secret instruction',
      tools: [],
    })

    // System message should have been sent to provider
    assert.equal(provider.lastMessages[0]!.role, 'system')
    assert.equal(provider.lastMessages[0]!.content, 'Secret instruction')

    // But instruction should NOT be in context messages
    const systemMsgs = ctx.messages.filter(m => m.role === 'system')
    assert.equal(systemMsgs.length, 0)
  })

  it('executes a single tool call then returns text', async () => {
    const weatherTool = createTool({
      id: 'get_weather',
      description: 'Get weather',
      schema: { city: { type: 'string', description: 'City' } },
      execute: async (args) => ({
        city: (args as any).city,
        temp: 22,
      }),
    })

    const provider = mockProvider([
      {
        toolCalls: [
          { id: 'call_1', name: 'get_weather', arguments: { city: 'Tokyo' } },
        ],
      },
      { content: 'It is 22°C in Tokyo.' },
    ])

    const ctx = createContext()
    ctx.push('Weather in Tokyo?')

    const result = await runAgent({
      ctx,
      provider,
      instruction: 'Answer questions',
      tools: [weatherTool],
    })

    assert.equal(result.response, 'It is 22°C in Tokyo.')
    assert.equal(result.steps, 2)

    // Context should have: user, assistant+toolCalls, tool result, assistant
    assert.equal(ctx.messages.length, 4)
    assert.equal(ctx.messages[0]!.role, 'user')
    assert.equal(ctx.messages[1]!.role, 'assistant')
    assert.equal(ctx.messages[1]!.toolCalls!.length, 1)
    assert.equal(ctx.messages[2]!.role, 'tool')
    assert.equal(ctx.messages[2]!.toolCallId, 'call_1')
    assert.equal(ctx.messages[3]!.role, 'assistant')
    assert.equal(ctx.messages[3]!.content, 'It is 22°C in Tokyo.')
  })

  it('handles multi-step tool calls', async () => {
    let callCount = 0
    const tool = createTool({
      id: 'step',
      description: 'Do a step',
      execute: async () => {
        callCount++
        return `step ${callCount}`
      },
    })

    const provider = mockProvider([
      { toolCalls: [{ id: 'c1', name: 'step', arguments: {} }] },
      { toolCalls: [{ id: 'c2', name: 'step', arguments: {} }] },
      { content: 'All done.' },
    ])

    const ctx = createContext()
    ctx.push('Go')

    const result = await runAgent({
      ctx,
      provider,
      instruction: 'Run steps',
      tools: [tool],
    })

    assert.equal(result.response, 'All done.')
    assert.equal(result.steps, 3)
    assert.equal(callCount, 2)
  })

  it('throws MaxStepsError when limit exceeded', async () => {
    const provider = mockProvider(
      Array.from({ length: 10 }, () => ({
        toolCalls: [{ id: 'c', name: 'noop', arguments: {} }],
      })),
    )

    const tool = createTool({
      id: 'noop',
      description: 'No-op',
      execute: async () => null,
    })

    const ctx = createContext()
    ctx.push('Go')

    await assert.rejects(
      () =>
        runAgent({
          ctx,
          provider,
          instruction: 'Loop',
          tools: [tool],
          maxSteps: 3,
        }),
      MaxStepsError,
    )
  })

  it('handles unknown tool gracefully', async () => {
    const provider = mockProvider([
      {
        toolCalls: [
          { id: 'c1', name: 'nonexistent', arguments: {} },
        ],
      },
      { content: 'Recovered.' },
    ])

    const ctx = createContext()
    ctx.push('Go')

    const result = await runAgent({
      ctx,
      provider,
      instruction: 'Recover',
      tools: [],
    })

    assert.equal(result.response, 'Recovered.')
    // The error should be in context so model can see it
    const toolMsg = ctx.messages.find(m => m.role === 'tool')
    assert.ok(toolMsg!.content.includes('unknown tool'))
  })

  it('handles tool execution error gracefully', async () => {
    const brokenTool = createTool({
      id: 'broken',
      description: 'Always fails',
      execute: async () => {
        throw new Error('Kaboom!')
      },
    })

    const provider = mockProvider([
      { toolCalls: [{ id: 'c1', name: 'broken', arguments: {} }] },
      { content: 'Handled the error.' },
    ])

    const ctx = createContext()
    ctx.push('Go')

    const result = await runAgent({
      ctx,
      provider,
      instruction: 'Handle errors',
      tools: [brokenTool],
    })

    assert.equal(result.response, 'Handled the error.')
    const toolMsg = ctx.messages.find(m => m.role === 'tool')
    assert.ok(toolMsg!.content.includes('Kaboom!'))
  })

  it('onBeforeToolCall can block a tool', async () => {
    const tool = createTool({
      id: 'dangerous',
      description: 'Dangerous op',
      execute: async () => 'should not run',
    })

    const provider = mockProvider([
      { toolCalls: [{ id: 'c1', name: 'dangerous', arguments: {} }] },
      { content: 'OK, skipped.' },
    ])

    const ctx = createContext()
    ctx.push('Go')

    const result = await runAgent({
      ctx,
      provider,
      instruction: 'Be careful',
      tools: [tool],
      onBeforeToolCall: () => false,
    })

    assert.equal(result.response, 'OK, skipped.')
    const toolMsg = ctx.messages.find(m => m.role === 'tool')
    assert.ok(toolMsg!.content.includes('blocked'))
  })

  it('onAfterToolCall is called with result', async () => {
    let captured: unknown = null

    const tool = createTool({
      id: 'echo',
      description: 'Echo',
      execute: async () => 'echoed',
    })

    const provider = mockProvider([
      { toolCalls: [{ id: 'c1', name: 'echo', arguments: {} }] },
      { content: 'Done.' },
    ])

    const ctx = createContext()
    ctx.push('Go')

    await runAgent({
      ctx,
      provider,
      instruction: 'Echo',
      tools: [tool],
      onAfterToolCall: (_tool, _args, result) => {
        captured = result
      },
    })

    assert.equal(captured, 'echoed')
  })
})
