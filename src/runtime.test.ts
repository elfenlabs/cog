import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  ContextChain,
  defineGraph,
  GraphRuntime,
  GraphControlError,
  SideChannel,
  key,
  resetHandleCounter,
} from './index.js'
import type {
  LLMProvider,
  LLMResult,
  LLMCallNodeConfig,
  RouterNodeConfig,
  ToolCallNodeConfig,
  ContextFormatter,
} from './index.js'

// ===========================================================================
// Helpers
// ===========================================================================

beforeEach(() => resetHandleCounter())

/** Simple formatter: join all node contents with newline */
const textFormatter: ContextFormatter<string> = (nodes) =>
  nodes.map(n => String(n.content)).join('\n')

/** Create a mock LLM provider that returns predetermined responses */
function mockProvider(responses: LLMResult[]): LLMProvider {
  let callIndex = 0
  return {
    async generate(params) {
      const response = responses[callIndex % responses.length]
      callIndex++
      // Call onChunk if provided (streaming simulation)
      if (params.onChunk && response.content) {
        for (const char of response.content) {
          params.onChunk(char)
        }
      }
      return response
    },
  }
}

// ===========================================================================
// Runtime Tests
// ===========================================================================

describe('GraphRuntime', () => {
  it('should execute a simple linear graph', async () => {
    const chain = new ContextChain()
    chain.insert('System: you are helpful', { type: 'head' })

    const provider = mockProvider([
      { content: 'Hello from the agent' },
    ])

    const graph = defineGraph({
      nodes: {
        greet: {
          type: 'llm', id: 'greet',
          instructions: 'Say hello',
        } satisfies LLMCallNodeConfig,
      },
      entryNode: 'greet',
      terminalNodes: ['greet'],
    })

    const runtime = new GraphRuntime()
    const result = await runtime.run(graph, chain, {
      llmProvider: provider,
      contextFormatter: textFormatter,
    })

    assert.equal(result.finalNodeId, 'greet')
    assert.equal(result.steps, 1)
  })

  it('should execute a graph with routing', async () => {
    const transitions: string[] = []

    const provider = mockProvider([
      { content: 'Analysis complete', toolCalls: [{ name: 'readFile', arguments: { path: '/tmp' } }] },
      { content: 'Tool result processed' },
      { content: 'Final answer' },
    ])

    const graph = defineGraph({
      nodes: {
        analyze: {
          type: 'llm', id: 'analyze',
          instructions: 'Analyze',
          next: [{ to: 'route' }],
        } satisfies LLMCallNodeConfig,
        route: {
          type: 'router', id: 'route',
          route: (result) => {
            const r = result as LLMResult
            return r.toolCalls?.length ? 'tool' : 'done'
          },
          next: [
            { to: 'executeTool', on: 'tool' },
            { to: 'done', on: 'done' },
          ],
        } satisfies RouterNodeConfig,
        executeTool: {
          type: 'tool', id: 'executeTool',
          execute: async () => ({ result: 'file contents' }),
          next: [{ to: 'respond' }],
        } satisfies ToolCallNodeConfig,
        respond: {
          type: 'llm', id: 'respond',
          instructions: 'Respond with tool results',
          next: [{ to: 'route2' }],
        } satisfies LLMCallNodeConfig,
        route2: {
          type: 'router', id: 'route2',
          route: (result) => {
            const r = result as LLMResult
            return r.toolCalls?.length ? 'tool' : 'done'
          },
          next: [
            { to: 'executeTool', on: 'tool' },
            { to: 'done', on: 'done' },
          ],
        } satisfies RouterNodeConfig,
        done: {
          type: 'llm', id: 'done',
          instructions: 'Summarize',
        } satisfies LLMCallNodeConfig,
      },
      entryNode: 'analyze',
      terminalNodes: ['done'],
    })

    const runtime = new GraphRuntime()
    const result = await runtime.run(graph, chain, {
      llmProvider: provider,
      contextFormatter: textFormatter,
      onTransition: (from, to) => transitions.push(`${from} → ${to}`),
    })

    assert.equal(result.finalNodeId, 'done')
    assert.ok(transitions.includes('analyze → route'))
    assert.ok(transitions.includes('route → executeTool'))
  })

  it('should handle transition guards (when)', async () => {
    const provider = mockProvider([
      { content: 'result', toolCalls: [{ name: 'tool', arguments: {} }] },
    ])

    const graph = defineGraph({
      nodes: {
        start: {
          type: 'llm', id: 'start',
          instructions: 'Go',
          next: [
            {
              to: 'withTools',
              when: (output) => {
                const r = output as LLMResult
                return (r.toolCalls?.length ?? 0) > 0
              },
            },
            { to: 'noTools' },
          ],
        } satisfies LLMCallNodeConfig,
        withTools: {
          type: 'llm', id: 'withTools',
          instructions: 'Has tools',
        } satisfies LLMCallNodeConfig,
        noTools: {
          type: 'llm', id: 'noTools',
          instructions: 'No tools',
        } satisfies LLMCallNodeConfig,
      },
      entryNode: 'start',
      terminalNodes: ['withTools', 'noTools'],
    })

    const runtime = new GraphRuntime()
    const result = await runtime.run(graph, chain, {
      llmProvider: provider,
      contextFormatter: textFormatter,
    })

    assert.equal(result.finalNodeId, 'withTools')
  })

  it('should enforce maxSteps', async () => {
    const provider = mockProvider([{ content: 'loop' }])

    const graph = defineGraph({
      nodes: {
        loop: {
          type: 'llm', id: 'loop',
          instructions: 'Loop forever',
          next: [{ to: 'loop' }],
        } satisfies LLMCallNodeConfig,
      },
      entryNode: 'loop',
      terminalNodes: [],
    })

    const runtime = new GraphRuntime()
    await assert.rejects(
      runtime.run(graph, chain, {
        llmProvider: provider,
        contextFormatter: textFormatter,
        maxSteps: 5,
      }),
      (err: unknown) => {
        assert.ok(err instanceof GraphControlError)
        assert.ok(err.message.includes('Maximum steps'))
        return true
      },
    )
  })

  it('should handle error with transition mode', async () => {
    const failingProvider: LLMProvider = {
      async generate() { throw new Error('API down') },
    }

    const graph = defineGraph({
      nodes: {
        start: {
          type: 'llm', id: 'start',
          instructions: 'Will fail',
          next: [{ to: 'end' }],
        } satisfies LLMCallNodeConfig,
        error: {
          type: 'llm', id: 'error',
          instructions: 'Handle error',
        } satisfies LLMCallNodeConfig,
        end: {
          type: 'llm', id: 'end',
          instructions: 'Normal end',
        } satisfies LLMCallNodeConfig,
      },
      entryNode: 'start',
      terminalNodes: ['error', 'end'],
    })

    // Use a provider that fails on first call, succeeds on second
    let callCount = 0
    const mixedProvider: LLMProvider = {
      async generate() {
        callCount++
        if (callCount === 1) throw new Error('API down')
        return { content: 'Recovered' }
      },
    }

    const runtime = new GraphRuntime()
    const result = await runtime.run(graph, chain, {
      llmProvider: mixedProvider,
      contextFormatter: textFormatter,
      onError: 'transition',
      errorNode: 'error',
    })

    assert.equal(result.finalNodeId, 'error')
    // Check side channel has error info
    assert.ok(result.sideChannel.has('__error' as any))
  })

  it('should support AbortSignal cancellation', async () => {
    const controller = new AbortController()
    controller.abort()

    const provider = mockProvider([{ content: 'wont reach' }])
    const graph = defineGraph({
      nodes: {
        start: {
          type: 'llm', id: 'start',
          instructions: 'x',
        } satisfies LLMCallNodeConfig,
      },
      entryNode: 'start',
      terminalNodes: ['start'],
    })

    const runtime = new GraphRuntime()
    await assert.rejects(
      runtime.run(graph, chain, {
        llmProvider: provider,
        contextFormatter: textFormatter,
        signal: controller.signal,
      }),
      (err: unknown) => {
        assert.ok(err instanceof GraphControlError)
        assert.ok(err.message.includes('aborted'))
        return true
      },
    )
  })

  it('should manage scratch node lifecycle', async () => {
    const chain = new ContextChain()
    chain.insert('System prompt', { type: 'head' })

    let contextDuringExecution = ''

    const provider: LLMProvider = {
      async generate(params) {
        contextDuringExecution = params.context as string
        return { content: 'done' }
      },
    }

    const graph = defineGraph({
      nodes: {
        analyze: {
          type: 'llm', id: 'analyze',
          instructions: 'Analyze this',
          scratchNodes: [{
            content: 'SCRATCH: raw log data here...',
            collapseOnExit: async (content) => `Summary: ${content.slice(0, 10)}`,
          }],
        } satisfies LLMCallNodeConfig,
      },
      entryNode: 'analyze',
      terminalNodes: ['analyze'],
    })

    const runtime = new GraphRuntime()
    const result = await runtime.run(graph, chain, {
      llmProvider: provider,
      contextFormatter: textFormatter,
    })

    // During execution, scratch was in context
    assert.ok(contextDuringExecution.includes('SCRATCH: raw log data'))

    // After execution, scratch was collapsed (content replaced)
    // The chain should have: system prompt + collapsed scratch
    const finalNodes = chain.getAll()
    const contents = finalNodes.map(n => String(n.content))
    assert.ok(contents.some(c => c.startsWith('Summary:')), 'Scratch should be collapsed')
    assert.ok(!contents.some(c => c.includes('SCRATCH: raw log data')), 'Original scratch should be gone')
  })
})

// ===========================================================================
// End-to-End: Realistic Agent Loop with Mocked LLM
// ===========================================================================

describe('E2E: Multi-turn agent with tool use', () => {
  it('should complete a full analyze → tool → summarize loop', async () => {
    // --- Setup: simulate a code review agent ---
    const chain = new ContextChain()
    const systemPrompt = chain.insert(
      'You are a code review agent. Analyze code and report issues.',
      { type: 'head' },
    )

    // Track everything that happens
    const log: string[] = []
    const streamedChunks: string[] = []
    const contextSnapshots: string[] = []

    // Mock LLM: responds differently based on call sequence
    let llmCallCount = 0
    const provider: LLMProvider = {
      async generate(params) {
        llmCallCount++
        const ctx = params.context as string
        contextSnapshots.push(ctx) // capture what the LLM sees

        // Simulate onChunk streaming
        if (params.onChunk) {
          for (const word of ['thinking', '...', 'done']) {
            params.onChunk(word)
            streamedChunks.push(word)
          }
        }

        switch (llmCallCount) {
          case 1:
            // First call: LLM wants to read a file
            log.push('LLM: requesting readFile tool')
            return {
              content: 'I need to read the source file first.',
              toolCalls: [{ name: 'readFile', arguments: { path: 'src/main.ts' } }],
            }
          case 2:
            // Second call: after tool result, LLM wants another tool
            log.push('LLM: requesting lintCheck tool')
            return {
              content: 'File read. Now checking lint issues.',
              toolCalls: [{ name: 'lintCheck', arguments: { path: 'src/main.ts' } }],
            }
          case 3:
            // Third call: done analyzing, no more tools needed
            log.push('LLM: analysis complete, no more tools')
            return {
              content: 'Analysis complete. I found 2 issues.',
            }
          case 4:
            // Fourth call: summarize node
            log.push('LLM: providing final summary')
            return {
              content: 'Found 2 issues: unused import on line 3, missing return type on line 15.',
            }
          default:
            return { content: 'Unexpected call' }
        }
      },
    }

    // Define tools
    const readFile = {
      name: 'readFile',
      description: 'Read a source file',
      parameters: { path: { type: 'string' as const, required: true } },
      execute: async (args: { path: string }) => {
        log.push(`Tool: readFile(${args.path})`)
        return { content: 'const x = 1;\nimport { unused } from "./lib";\nfunction foo() { return x }' }
      },
    }

    const lintCheck = {
      name: 'lintCheck',
      description: 'Run lint checks on a file',
      parameters: { path: { type: 'string' as const, required: true } },
      execute: async (args: { path: string }) => {
        log.push(`Tool: lintCheck(${args.path})`)
        return { issues: ['unused import: line 3', 'missing return type: line 15'] }
      },
    }

    // Side channel key for accumulating issues
    const issuesKey = key<string[]>('issues')

    // Side channel key for the last LLM result (router stashes it)
    const lastLLMResult = key<LLMResult>('lastLLMResult')

    // Build the graph
    const graph = defineGraph({
      tools: [readFile, lintCheck], // graph-wide tools
      nodes: {
        analyze: {
          type: 'llm', id: 'analyze',
          instructions: 'Analyze the code and identify issues. Use tools if needed.',
          onChunk: (chunk) => { /* streaming handled in provider */ },
          next: [{ to: 'decide' }],
        } satisfies LLMCallNodeConfig,

        decide: {
          type: 'router', id: 'decide',
          route: (result, sideChannel) => {
            const r = result as LLMResult
            // Stash the full LLM result for the tool node to use
            sideChannel.set(lastLLMResult, r)
            if (r.toolCalls && r.toolCalls.length > 0) return 'useTool'
            return 'summarize'
          },
          next: [
            { to: 'executeTool', on: 'useTool' },
            { to: 'summarize', on: 'summarize' },
          ],
        } satisfies RouterNodeConfig,

        executeTool: {
          type: 'tool', id: 'executeTool',
          execute: async (_input, ctx) => {
            // Retrieve the LLM result from side channel (stashed by router)
            const llmResult = ctx.sideChannel.get(lastLLMResult)!
            const toolCall = llmResult.toolCalls![0]
            const tool = [readFile, lintCheck].find(t => t.name === toolCall.name)
            if (!tool) throw new Error(`Unknown tool: ${toolCall.name}`)

            const result = await tool.execute(toolCall.arguments as any)

            // Add tool result to context chain as floating node
            ctx.chain.insert(
              `[Tool: ${toolCall.name}] Result: ${JSON.stringify(result)}`,
            )

            // Track issues in side channel
            if (toolCall.name === 'lintCheck') {
              const existing = ctx.sideChannel.get(issuesKey) ?? []
              const lintResult = result as { issues: string[] }
              ctx.sideChannel.set(issuesKey, [...existing, ...lintResult.issues])
            }

            return result
          },
          next: [{ to: 'analyze' }], // loop back for more analysis
        } satisfies ToolCallNodeConfig,

        summarize: {
          type: 'llm', id: 'summarize',
          instructions: 'Provide your final code review summary.',
          scratchNodes: [{
            content: 'Review notes: ',
            collapseOnExit: async (content) => `[Collapsed] ${content.slice(0, 30)}`,
          }],
        } satisfies LLMCallNodeConfig,
      },
      entryNode: 'analyze',
      terminalNodes: ['summarize'],
    })

    // Run the agent
    const transitions: string[] = []
    const runtime = new GraphRuntime()
    const result = await runtime.run(graph, chain, {
      llmProvider: provider,
      contextFormatter: textFormatter,
      maxSteps: 20,
      onTransition: (from, to) => transitions.push(`${from} → ${to}`),
      onNodeEnter: (id) => log.push(`Enter: ${id}`),
      onNodeExit: (id) => log.push(`Exit: ${id}`),
    })

    // --- Assertions ---

    // 1. Graph completed at summarize node
    assert.equal(result.finalNodeId, 'summarize')

    // 2. LLM was called 4 times (analyze x3 + summarize x1)
    assert.equal(llmCallCount, 4)

    // 3. Tools were invoked in order
    assert.ok(log.includes('Tool: readFile(src/main.ts)'))
    assert.ok(log.includes('Tool: lintCheck(src/main.ts)'))

    // 4. Routing worked: analyze → decide → tool → analyze → decide → tool → analyze → decide → summarize
    assert.ok(transitions.includes('analyze → decide'))
    assert.ok(transitions.includes('decide → executeTool'))
    assert.ok(transitions.includes('executeTool → analyze'))
    assert.ok(transitions.includes('decide → summarize'))

    // 5. Side channel accumulated lint issues
    const issues = result.sideChannel.get(issuesKey)
    assert.ok(issues)
    assert.equal(issues.length, 2)
    assert.ok(issues.includes('unused import: line 3'))
    assert.ok(issues.includes('missing return type: line 15'))

    // 6. Context chain grew with tool results
    const allNodes = chain.getAll()
    const toolResultNodes = allNodes.filter(n =>
      String(n.content).startsWith('[Tool:'),
    )
    assert.equal(toolResultNodes.length, 2, 'Two tool results should be in context')

    // 7. Scratch node was collapsed after summarize
    const scratchNodes = allNodes.filter(n =>
      String(n.content).startsWith('[Collapsed]'),
    )
    assert.equal(scratchNodes.length, 1, 'Scratch should be collapsed')

    // 8. Streaming chunks were received
    assert.ok(streamedChunks.length > 0, 'Should have received streamed chunks')

    // 9. Context snapshots show progressive accumulation
    // First LLM call sees system prompt + instructions
    assert.ok(contextSnapshots[0].includes('code review agent'))
    // Second call should see first tool result
    assert.ok(contextSnapshots[1].includes('[Tool: readFile]'))
    // Third call should see both tool results
    assert.ok(contextSnapshots[2].includes('[Tool: lintCheck]'))
    // Fourth call (summarize) should also see both tool results
    assert.ok(contextSnapshots[3].includes('[Tool: lintCheck]'))
  })
})

// Shared chain for tests
const chain = new ContextChain()
