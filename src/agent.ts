/**
 * Cog v2 — Agent Loop
 *
 * The heart of the library. Calls the model in a loop,
 * executing tool calls until the model responds with text only.
 */

import type { Context } from './context.js'
import type { Tool } from './tool.js'
import type { Message, Provider, StreamCallbacks, Usage } from './types.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type AgentConfig = {
  ctx: Context
  provider: Provider
  instruction: string
  tools: Tool<any>[]
  maxSteps?: number
  signal?: AbortSignal
  onThinkingStart?: () => void
  onThinking?: (chunk: string) => void
  onThinkingEnd?: () => void
  onOutputStart?: () => void
  onOutput?: (chunk: string) => void
  onOutputEnd?: () => void
  onBeforeToolCall?: (
    tool: Tool<any>,
    args: Record<string, unknown>,
  ) => Promise<boolean | void> | boolean | void
  onAfterToolCall?: (
    tool: Tool<any>,
    args: Record<string, unknown>,
    result: unknown,
  ) => void
}

export type AgentResult = {
  response: string
  steps: number
  usage: Usage
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
    onThinkingStart,
    onThinking,
    onThinkingEnd,
    onOutputStart,
    onOutput,
    onOutputEnd,
    onBeforeToolCall,
    onAfterToolCall,
  } = config

  const toolMap = new Map(tools.map(t => [t.id, t]))
  const toolSpecs = tools.map(t => t.spec)

  let steps = 0
  let isThinking = false
  let isOutputting = false
  const totalUsage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

  /** End reasoning block if one is active */
  const endThinking = () => {
    if (isThinking) {
      isThinking = false
      onThinkingEnd?.()
    }
  }

  /** End output block if one is active */
  const endOutput = () => {
    if (isOutputting) {
      isOutputting = false
      onOutputEnd?.()
    }
  }

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
    // Wrap onThinking to manage start/end lifecycle
    const wrappedOnThinking = onThinking
      ? (chunk: string) => {
          if (!isThinking) {
            isThinking = true
            onThinkingStart?.()
          }
          onThinking(chunk)
        }
      : undefined

    const wrappedOnOutput = onOutput
      ? (chunk: string) => {
          if (!isOutputting) {
            isOutputting = true
            onOutputStart?.()
          }
          onOutput(chunk)
        }
      : undefined

    const stream: StreamCallbacks | undefined =
      wrappedOnThinking || wrappedOnOutput
        ? {
            onReasoning: wrappedOnThinking,
            onContent: wrappedOnOutput,
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

    // Accumulate token usage
    if (result.usage) {
      totalUsage.promptTokens += result.usage.promptTokens
      totalUsage.completionTokens += result.usage.completionTokens
      totalUsage.totalTokens += result.usage.totalTokens
    }

    // Case 1: Model returned tool calls → execute and loop
    if (result.toolCalls && result.toolCalls.length > 0) {
      endThinking()
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
          const allowed = await onBeforeToolCall(tool, call.arguments)
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
      endThinking()
      endOutput()
      ctx.push({
        role: 'assistant',
        content: result.content,
        reasoning: result.reasoning,
      })
      return { response: result.content, steps, usage: totalUsage }
    }

    // Case 3: Reasoning only (no content, no tool calls) — continue loop
    // Reasoning models sometimes produce a think step before acting.
    if (result.reasoning) {
      ctx.push({
        role: 'assistant',
        content: '',
        reasoning: result.reasoning,
      })
      continue
    }

    // Case 4: Nothing at all — error
    throw new Error('Provider returned neither content nor tool calls')
  }
}
