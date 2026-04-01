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
      async () => {
        await runAgent({
          ctx,
          provider,
          instruction: 'Loop',
          tools: [tool],
          maxSteps: 3,
        })
      },
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

  it('handles malformed tool call arguments (parseError) gracefully', async () => {
    const tool = createTool({
      id: 'my_tool',
      description: 'A tool',
      execute: async () => 'should not run',
    })

    const provider = mockProvider([
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'my_tool',
            arguments: {},
            parseError: 'Malformed tool call arguments (invalid JSON): {broken',
          },
        ],
      },
      { content: 'Recovered from bad JSON.' },
    ])

    const ctx = createContext()
    ctx.push('Go')

    const result = await runAgent({
      ctx,
      provider,
      instruction: 'Handle parse errors',
      tools: [tool],
    })

    assert.equal(result.response, 'Recovered from bad JSON.')
    assert.equal(result.steps, 2)

    // The error message should be in context as a tool result
    const toolMsg = ctx.messages.find(m => m.role === 'tool')
    assert.ok(toolMsg)
    assert.ok(toolMsg!.content.includes('Malformed tool call arguments'))
    assert.ok(toolMsg!.content.includes('Please retry with valid JSON arguments'))
    assert.equal(toolMsg!.toolCallId, 'c1')
  })

  it('truncates tool output exceeding default limit', async () => {
    const bigOutput = 'x'.repeat(15_000)
    const tool = createTool({
      id: 'big',
      description: 'Returns big output',
      execute: async () => bigOutput,
    })

    const provider = mockProvider([
      { toolCalls: [{ id: 'c1', name: 'big', arguments: {} }] },
      { content: 'Done.' },
    ])

    const ctx = createContext()
    ctx.push('Go')

    await runAgent({
      ctx,
      provider,
      instruction: 'Go',
      tools: [tool],
    })

    const toolMsg = ctx.messages.find(m => m.role === 'tool')
    assert.ok(toolMsg)
    assert.ok(toolMsg!.content.length < bigOutput.length)
    assert.ok(toolMsg!.content.includes('truncated'))
    assert.ok(toolMsg!.content.includes('15000'))
    assert.ok(toolMsg!.content.includes('10000'))
  })

  it('per-tool maxOutputChars overrides default', async () => {
    const tool = createTool({
      id: 'small',
      description: 'Small cap',
      maxOutputChars: 50,
      execute: async () => 'a'.repeat(200),
    })

    const provider = mockProvider([
      { toolCalls: [{ id: 'c1', name: 'small', arguments: {} }] },
      { content: 'Done.' },
    ])

    const ctx = createContext()
    ctx.push('Go')

    await runAgent({
      ctx,
      provider,
      instruction: 'Go',
      tools: [tool],
    })

    const toolMsg = ctx.messages.find(m => m.role === 'tool')
    assert.ok(toolMsg)
    // First 50 chars + truncation marker
    assert.ok(toolMsg!.content.startsWith('a'.repeat(50)))
    assert.ok(toolMsg!.content.includes('truncated'))
    assert.ok(toolMsg!.content.includes('→ 50 chars'))
  })

  it('agent-level defaultMaxOutputChars overrides hardcoded default', async () => {
    const tool = createTool({
      id: 'medium',
      description: 'No per-tool cap',
      execute: async () => 'b'.repeat(500),
    })

    const provider = mockProvider([
      { toolCalls: [{ id: 'c1', name: 'medium', arguments: {} }] },
      { content: 'Done.' },
    ])

    const ctx = createContext()
    ctx.push('Go')

    await runAgent({
      ctx,
      provider,
      instruction: 'Go',
      tools: [tool],
      defaultMaxOutputChars: 100,
    })

    const toolMsg = ctx.messages.find(m => m.role === 'tool')
    assert.ok(toolMsg)
    assert.ok(toolMsg!.content.startsWith('b'.repeat(100)))
    assert.ok(toolMsg!.content.includes('truncated'))
    assert.ok(toolMsg!.content.includes('→ 100 chars'))
  })

  it('runs compaction before generate() when strategy is set', async () => {
    // Fill context with enough messages to trigger eviction
    const ctx = createContext()
    for (let i = 0; i < 10; i++) {
      ctx.push('M'.repeat(100)) // 100 chars each
    }

    const provider = mockProvider([{ content: 'Done.' }])
    const { SlidingWindowStrategy } = await import('./strategy.js')

    const result = await runAgent({
      ctx,
      provider,
      instruction: 'Go',
      tools: [],
      maxContextTokens: 300, // 300 tokens budget total
      evictionStrategy: new SlidingWindowStrategy(),
      tokenCounter: (text: string) => text.length, // 1 char = 1 token
    })

    assert.equal(result.response, 'Done.')
    // Messages should have been compacted — fewer than the original 10 + 1 (assistant)
    // instruction "Go" = 2 tokens, so budget for messages = 298
    // Each message is 100 tokens, so at most 2 fit
    assert.ok(ctx.messages.length < 11) // compaction happened
  })

  it('throws ContextBudgetError when fixed cost exceeds limit', async () => {
    const ctx = createContext()
    ctx.push('hello')

    const provider = mockProvider([{ content: 'Done.' }])
    const { SlidingWindowStrategy } = await import('./strategy.js')
    const { ContextBudgetError } = await import('./agent.js')

    await assert.rejects(
      async () => {
        await runAgent({
          ctx,
          provider,
          instruction: 'X'.repeat(500), // 500 token instruction
          tools: [],
          maxContextTokens: 100, // only 100 tokens budget
          evictionStrategy: new SlidingWindowStrategy(),
          tokenCounter: (text: string) => text.length,
        })
      },
      ContextBudgetError,
    )
  })

  it('pinned messages survive compaction through agent loop', async () => {
    const ctx = createContext()
    ctx.push({ role: 'user', content: 'P'.repeat(50), pinned: true })
    for (let i = 0; i < 5; i++) {
      ctx.push('X'.repeat(100))
    }

    const provider = mockProvider([{ content: 'Done.' }])
    const { SlidingWindowStrategy } = await import('./strategy.js')

    await runAgent({
      ctx,
      provider,
      instruction: 'Go',
      tools: [],
      maxContextTokens: 200,
      evictionStrategy: new SlidingWindowStrategy(),
      tokenCounter: (text: string) => text.length,
    })

    // Pinned message must survive
    const pinned = ctx.messages.filter(m => m.pinned)
    assert.equal(pinned.length, 1)
    assert.equal(pinned[0]!.content, 'P'.repeat(50))
  })

  it('no compaction when evictionStrategy is not set (backward compatible)', async () => {
    const ctx = createContext()
    for (let i = 0; i < 10; i++) {
      ctx.push('M'.repeat(100))
    }

    const provider = mockProvider([{ content: 'Done.' }])

    const result = await runAgent({
      ctx,
      provider,
      instruction: 'Go',
      tools: [],
      // No evictionStrategy — should not compact
    })

    assert.equal(result.response, 'Done.')
    // All 10 user messages + 1 assistant response = 11
    assert.equal(ctx.messages.length, 11)
  })

  it('reasoning tokens NOT counted in budget by default (includesReasoning unset)', async () => {
    const ctx = createContext()
    // Push messages with reasoning — each has 50-char content + 200-char reasoning = 250 total
    // But without includesReasoning, only content (50 chars) should be counted
    for (let i = 0; i < 5; i++) {
      ctx.push({
        role: 'assistant',
        content: 'C'.repeat(50),
        reasoning: 'R'.repeat(200),
      })
      ctx.push('U'.repeat(50))
    }

    const provider = mockProvider([{ content: 'Done.' }])
    // Default: provider has no includesReasoning set (undefined → false)
    const { SlidingWindowStrategy } = await import('./strategy.js')

    await runAgent({
      ctx,
      provider,
      instruction: 'Go',
      tools: [],
      maxContextTokens: 350, // 350 token budget - 2 for instruction = 348 for messages
      evictionStrategy: new SlidingWindowStrategy(),
      tokenCounter: (text: string) => text.length, // 1 char = 1 token
    })

    // With reasoning excluded: each pair costs 100 tokens (50+50).
    // With reasoning included: each pair costs 300 tokens (250+50).
    // The key assertion: reasoning-bearing messages are NOT aggressively evicted.
    // We should have more messages than if reasoning were counted.
    // The "+ 1" accounts for the final assistant 'Done.' response.
    assert.ok(ctx.messages.length >= 3, `Expected >= 3 messages, got ${ctx.messages.length}`)
  })

  it('reasoning tokens counted in budget when provider.includesReasoning is true', async () => {
    const ctx = createContext()
    // Same setup: 50-char content + 200-char reasoning
    for (let i = 0; i < 5; i++) {
      ctx.push({
        role: 'assistant',
        content: 'C'.repeat(50),
        reasoning: 'R'.repeat(200),
      })
      ctx.push('U'.repeat(50))
    }

    const provider = mockProvider([{ content: 'Done.' }])
    // Set includesReasoning to true
    ;(provider as any).includesReasoning = true
    const { SlidingWindowStrategy } = await import('./strategy.js')

    await runAgent({
      ctx,
      provider,
      instruction: 'Go',
      tools: [],
      maxContextTokens: 350,
      evictionStrategy: new SlidingWindowStrategy(),
      tokenCounter: (text: string) => text.length,
    })

    // With reasoning included: assistant msgs cost 250, user msgs cost 50
    // Budget = 348 tokens after instruction. Pairs cost 300 each.
    // Should aggressively evict — far fewer messages survive
    assert.ok(ctx.messages.length <= 4, `Expected <= 4 messages, got ${ctx.messages.length}`)
  })
})


// ── AgentRunHandle Tests ────────────────────────────────────────────────────

describe('AgentRunHandle', () => {
  it('status() reflects done state after completion', async () => {
    const provider = mockProvider([
      { content: 'Hello!' },
    ])
    const ctx = createContext()
    ctx.push('Hi')

    const run = runAgent({
      ctx,
      provider,
      instruction: 'Be helpful',
      tools: [],
    })

    await run
    const s = run.status()
    assert.equal(s.state, 'done')
    assert.equal(s.step, 1)
    assert.deepEqual(s.activeToolCalls, [])
  })

  it('status() reflects error state after failure', async () => {
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

    const run = runAgent({
      ctx,
      provider,
      instruction: 'Loop',
      tools: [tool],
      maxSteps: 3,
    })

    try {
      await run
    } catch {
      // expected
    }

    assert.equal(run.status().state, 'error')
  })

  it('status() shows correct step count', async () => {
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

    const run = runAgent({
      ctx,
      provider,
      instruction: 'Run steps',
      tools: [tool],
    })

    const result = await run
    assert.equal(result.steps, 3)
    assert.equal(run.status().step, 3)
    assert.equal(run.status().state, 'done')
  })

  it('onChange fires on state transitions', async () => {
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

    const run = runAgent({
      ctx,
      provider,
      instruction: 'Echo',
      tools: [tool],
    })

    const states: string[] = []
    run.onChange((status) => {
      states.push(status.state)
    })

    await run

    // Should see: thinking(0) → tool_call(1) → activeToolCalls set → activeToolCalls clear → thinking(1) → done(2)
    assert.ok(states.includes('thinking'))
    assert.ok(states.includes('tool_call'))
    assert.ok(states.includes('done'))
  })

  it('onChange unsubscribe stops callbacks', async () => {
    const provider = mockProvider([
      { content: 'Hello!' },
    ])
    const ctx = createContext()
    ctx.push('Hi')

    const run = runAgent({
      ctx,
      provider,
      instruction: 'Be helpful',
      tools: [],
    })

    let callCount = 0
    const unsub = run.onChange(() => {
      callCount++
    })

    // Unsubscribe immediately
    unsub()

    await run
    assert.equal(callCount, 0)
  })

  it('activeToolCalls populated during tool_call state', async () => {
    const tool = createTool({
      id: 'slow_tool',
      description: 'A slow tool',
      execute: async () => 'done',
    })

    const provider = mockProvider([
      { toolCalls: [{ id: 'call-1', name: 'slow_tool', arguments: { key: 'value' } }] },
      { content: 'Done.' },
    ])

    const ctx = createContext()
    ctx.push('Go')

    const run = runAgent({
      ctx,
      provider,
      instruction: 'Go',
      tools: [tool],
    })

    let capturedToolCalls: any[] = []
    run.onChange((status) => {
      if (status.activeToolCalls.length > 0) {
        capturedToolCalls = status.activeToolCalls
      }
    })

    await run

    assert.equal(capturedToolCalls.length, 1)
    assert.equal(capturedToolCalls[0]!.id, 'call-1')
    assert.equal(capturedToolCalls[0]!.toolId, 'slow_tool')
    assert.deepEqual(capturedToolCalls[0]!.args, { key: 'value' })
    assert.ok(capturedToolCalls[0]!.startedAt instanceof Date)
  })

  it('parallel tool execution runs all tools and collects results', async () => {
    const executionOrder: string[] = []

    const toolA = createTool({
      id: 'tool_a',
      description: 'Tool A',
      execute: async () => {
        executionOrder.push('a_start')
        executionOrder.push('a_end')
        return 'result_a'
      },
    })

    const toolB = createTool({
      id: 'tool_b',
      description: 'Tool B',
      execute: async () => {
        executionOrder.push('b_start')
        executionOrder.push('b_end')
        return 'result_b'
      },
    })

    const provider = mockProvider([
      {
        toolCalls: [
          { id: 'c1', name: 'tool_a', arguments: {} },
          { id: 'c2', name: 'tool_b', arguments: {} },
        ],
      },
      { content: 'Both done.' },
    ])

    const ctx = createContext()
    ctx.push('Go')

    const result = await runAgent({
      ctx,
      provider,
      instruction: 'Go',
      tools: [toolA, toolB],
    })

    assert.equal(result.response, 'Both done.')

    // Both tools executed
    assert.ok(executionOrder.includes('a_start'))
    assert.ok(executionOrder.includes('b_start'))

    // Both tool results in context
    const toolMsgs = ctx.messages.filter(m => m.role === 'tool')
    assert.equal(toolMsgs.length, 2)
    assert.equal(toolMsgs[0]!.toolCallId, 'c1')
    assert.equal(toolMsgs[1]!.toolCallId, 'c2')
  })

  it('parallel tool execution handles mixed success/failure', async () => {
    const goodTool = createTool({
      id: 'good',
      description: 'Works fine',
      execute: async () => 'success',
    })

    const badTool = createTool({
      id: 'bad',
      description: 'Always fails',
      execute: async () => {
        throw new Error('Kaboom!')
      },
    })

    const provider = mockProvider([
      {
        toolCalls: [
          { id: 'c1', name: 'good', arguments: {} },
          { id: 'c2', name: 'bad', arguments: {} },
        ],
      },
      { content: 'Recovered.' },
    ])

    const ctx = createContext()
    ctx.push('Go')

    const result = await runAgent({
      ctx,
      provider,
      instruction: 'Go',
      tools: [goodTool, badTool],
    })

    assert.equal(result.response, 'Recovered.')

    const toolMsgs = ctx.messages.filter(m => m.role === 'tool')
    assert.equal(toolMsgs.length, 2)
    assert.ok(toolMsgs[0]!.content.includes('success'))
    assert.ok(toolMsgs[1]!.content.includes('Kaboom!'))
  })

  it('multiple activeToolCalls shown for parallel execution', async () => {
    const toolA = createTool({
      id: 'alpha',
      description: 'Alpha',
      execute: async () => 'a',
    })

    const toolB = createTool({
      id: 'beta',
      description: 'Beta',
      execute: async () => 'b',
    })

    const provider = mockProvider([
      {
        toolCalls: [
          { id: 'c1', name: 'alpha', arguments: { x: 1 } },
          { id: 'c2', name: 'beta', arguments: { y: 2 } },
        ],
      },
      { content: 'Done.' },
    ])

    const ctx = createContext()
    ctx.push('Go')

    const run = runAgent({
      ctx,
      provider,
      instruction: 'Go',
      tools: [toolA, toolB],
    })

    let maxActiveToolCalls = 0
    run.onChange((status) => {
      if (status.activeToolCalls.length > maxActiveToolCalls) {
        maxActiveToolCalls = status.activeToolCalls.length
      }
    })

    await run

    // Both tool calls should have been registered simultaneously
    assert.equal(maxActiveToolCalls, 2)
  })
})

// ── Terminal Tool Tests ─────────────────────────────────────────────────────

describe('terminal tools', () => {
  it('terminal tool short-circuits the loop', async () => {
    const verdict = { approved: true, reason: 'Looks good' }
    const terminalTool = createTool({
      id: 'submit_verdict',
      description: 'Submit final verdict',
      terminal: true,
      execute: async () => verdict,
    })

    const provider = mockProvider([
      { toolCalls: [{ id: 'c1', name: 'submit_verdict', arguments: {} }] },
      // This second response should NEVER be reached
      { content: 'Should not appear' },
    ])

    const ctx = createContext()
    ctx.push('Review this')

    const result = await runAgent({
      ctx,
      provider,
      instruction: 'Review',
      tools: [terminalTool],
    })

    // Loop ended on the terminal tool — provider called only once
    assert.equal(provider.callCount, 1)
    assert.equal(result.steps, 1)

    // response is the stringified tool output
    assert.equal(result.response, JSON.stringify(verdict))

    // terminalToolResult holds the raw structured value
    assert.deepEqual(result.terminalToolResult, verdict)

    // Tool result still pushed to context (serialization fidelity)
    const toolMsg = ctx.messages.find(m => m.role === 'tool')
    assert.ok(toolMsg)
    assert.equal(toolMsg!.toolCallId, 'c1')
  })

  it('terminal + non-terminal in parallel: both execute, terminal wins', async () => {
    const normalTool = createTool({
      id: 'fetch_data',
      description: 'Fetch some data',
      execute: async () => 'fetched',
    })

    const terminalTool = createTool({
      id: 'submit_verdict',
      description: 'Submit final verdict',
      terminal: true,
      execute: async () => ({ done: true }),
    })

    const provider = mockProvider([
      {
        toolCalls: [
          { id: 'c1', name: 'fetch_data', arguments: {} },
          { id: 'c2', name: 'submit_verdict', arguments: {} },
        ],
      },
      { content: 'Should not appear' },
    ])

    const ctx = createContext()
    ctx.push('Go')

    const result = await runAgent({
      ctx,
      provider,
      instruction: 'Go',
      tools: [normalTool, terminalTool],
    })

    // Terminal tool ended the loop
    assert.equal(provider.callCount, 1)
    assert.deepEqual(result.terminalToolResult, { done: true })

    // Both tool results are in context
    const toolMsgs = ctx.messages.filter(m => m.role === 'tool')
    assert.equal(toolMsgs.length, 2)
  })
})

