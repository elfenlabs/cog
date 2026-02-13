/**
 * Cog v2 — Agent Loop
 *
 * The heart of the library. Calls the model in a loop,
 * executing tool calls until the model responds with text only.
 */

import type { Context } from './context.js'
import type { Tool } from './tool.js'
import type { Message, Provider, StreamCallbacks } from './types.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type AgentConfig = {
  ctx: Context
  provider: Provider
  instruction: string
  tools: Tool<any>[]
  maxSteps?: number
  signal?: AbortSignal
  onThinking?: (chunk: string) => void
  onOutput?: (chunk: string) => void
  onBeforeToolCall?: (
    tool: Tool<any>,
    args: Record<string, unknown>,
  ) => boolean | void
  onAfterToolCall?: (
    tool: Tool<any>,
    args: Record<string, unknown>,
    result: unknown,
  ) => void
}

export type AgentResult = {
  response: string
  steps: number
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class MaxStepsError extends Error {
  constructor(maxSteps: number) {
    super(`Agent exceeded maximum steps (${maxSteps})`)
    this.name = 'MaxStepsError'
  }
}

export class AgentAbortError extends Error {
  constructor() {
    super('Agent was aborted')
    this.name = 'AgentAbortError'
  }
}

// ── Agent Loop ──────────────────────────────────────────────────────────────

export async function runAgent(config: AgentConfig): Promise<AgentResult> {
  const {
    ctx,
    provider,
    instruction,
    tools,
    maxSteps = 50,
    signal,
    onThinking,
    onOutput,
    onBeforeToolCall,
    onAfterToolCall,
  } = config

  const toolMap = new Map(tools.map(t => [t.id, t]))
  const toolSpecs = tools.map(t => t.spec)

  let steps = 0

  while (true) {
    // Check abort
    if (signal?.aborted) {
      throw new AgentAbortError()
    }

    // Check step limit
    if (steps >= maxSteps) {
      throw new MaxStepsError(maxSteps)
    }

    // Build messages: instruction as system prompt + context messages
    const messages: Message[] = [
      { role: 'system', content: instruction },
      ...ctx.messages,
    ]

    // Build stream callbacks for the provider
    const stream: StreamCallbacks | undefined =
      onThinking || onOutput
        ? {
            onReasoning: onThinking,
            onContent: onOutput,
          }
        : undefined

    // Call the provider
    const result = await provider.generate({
      messages,
      tools: toolSpecs.length > 0 ? toolSpecs : undefined,
      signal,
      stream,
    })

    steps++

    // Case 1: Model returned tool calls → execute and loop
    if (result.toolCalls && result.toolCalls.length > 0) {
      // Append the assistant message with tool calls to context
      ctx.push({
        role: 'assistant',
        content: result.content ?? '',
        reasoning: result.reasoning,
        toolCalls: result.toolCalls,
      })

      for (const call of result.toolCalls) {
        const tool = toolMap.get(call.name)
        if (!tool) {
          // Unknown tool — append error as tool result so model can recover
          ctx.push({
            role: 'tool',
            content: `Error: unknown tool "${call.name}"`,
            toolCallId: call.id,
          })
          continue
        }

        // Hook: before
        if (onBeforeToolCall) {
          const allowed = onBeforeToolCall(tool, call.arguments)
          if (allowed === false) {
            ctx.push({
              role: 'tool',
              content: 'Error: tool call was blocked',
              toolCallId: call.id,
            })
            continue
          }
        }

        // Execute the tool
        try {
          const toolResult = await tool.execute(call.arguments as any, ctx)
          const content =
            typeof toolResult === 'string'
              ? toolResult
              : JSON.stringify(toolResult)

          ctx.push({
            role: 'tool',
            content,
            toolCallId: call.id,
          })

          // Hook: after
          if (onAfterToolCall) {
            onAfterToolCall(tool, call.arguments, toolResult)
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          ctx.push({
            role: 'tool',
            content: `Error: ${message}`,
            toolCallId: call.id,
          })
        }
      }

      // Continue the loop
      continue
    }

    // Case 2: Model returned text only → done
    if (result.content) {
      ctx.push({
        role: 'assistant',
        content: result.content,
        reasoning: result.reasoning,
      })
      return { response: result.content, steps }
    }

    // Case 3: Neither text nor tool calls → error
    throw new Error('Provider returned neither content nor tool calls')
  }
}
