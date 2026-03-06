/**
 * Nous — Agent Loop
 *
 * The heart of the library. Calls the model in a loop,
 * executing tool calls until the model responds with text only.
 */

import type { Context } from './context.js'
import type { Tool } from './tool.js'
import type { EvictionStrategy, TokenCounter } from './strategy.js'
import { defaultTokenCounter } from './strategy.js'
import type { Message, Provider, ToolSpec, StreamCallbacks, Usage } from './types.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type AgentConfig = {
  ctx: Context
  provider: Provider
  instruction: string
  tools: Tool<any>[]
  maxSteps?: number
  /** Max estimated tokens for the full request. Default: 100_000 */
  maxContextTokens?: number
  /** Automatic compaction strategy. Default: none (no auto-compaction) */
  evictionStrategy?: EvictionStrategy
  /** Token estimation function. Default: text.length / 4 */
  tokenCounter?: TokenCounter
  defaultMaxOutputChars?: number
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

export class ContextBudgetError extends Error {
  constructor(fixedCost: number, maxTokens: number) {
    super(
      `Fixed context (${Math.round(fixedCost)} tokens) exceeds maxContextTokens (${maxTokens})`,
    )
    this.name = 'ContextBudgetError'
  }
}

// ── Truncation ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_OUTPUT_CHARS = 10_000

function truncate(content: string, limit: number): string {
  if (content.length <= limit) return content
  return content.slice(0, limit) + `\n… (truncated: ${content.length} → ${limit} chars)`
}

// ── Budget ──────────────────────────────────────────────────────────────────

/** Estimate token cost of a single message (content + reasoning + tool call data) */
function messageTokenCost(msg: Message, tokenCounter: TokenCounter): number {
  let text = msg.content
  if (msg.reasoning) text += msg.reasoning
  if (msg.toolCalls) text += JSON.stringify(msg.toolCalls)
  if (msg.toolCallId) text += msg.toolCallId
  return tokenCounter(text)
}

/** Calculate the fixed token cost (instruction + tools + pinned messages) */
function calculateFixedCost(
  instruction: string,
  toolSpecs: ToolSpec[],
  ctx: Context,
  tokenCounter: TokenCounter,
): number {
  let cost = tokenCounter(instruction)
  if (toolSpecs.length > 0) {
    cost += tokenCounter(JSON.stringify(toolSpecs))
  }
  for (const msg of ctx.messages) {
    if (msg.pinned) {
      cost += messageTokenCost(msg, tokenCounter)
    }
  }
  return cost
}

// ── Agent Loop ──────────────────────────────────────────────────────────────

export async function runAgent(config: AgentConfig): Promise<AgentResult> {
  const {
    ctx,
    provider,
    instruction,
    tools,
    maxSteps = 50,
    maxContextTokens = 100_000,
    evictionStrategy,
    tokenCounter = defaultTokenCounter,
    defaultMaxOutputChars,
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

    // Compact context if strategy is configured
    if (evictionStrategy) {
      const fixedCost = calculateFixedCost(instruction, toolSpecs, ctx, tokenCounter)
      const budget = maxContextTokens - fixedCost
      if (budget <= 0) {
        throw new ContextBudgetError(fixedCost, maxContextTokens)
      }
      evictionStrategy.compact(ctx, budget, tokenCounter)
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
            endThinking()
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
      endOutput()
      // Append the assistant message with tool calls to context
      ctx.push({
        role: 'assistant',
        content: result.content ?? '',
        reasoning: result.reasoning,
        toolCalls: result.toolCalls,
      })

      for (const call of result.toolCalls) {
        // Handle malformed tool call arguments from model
        if (call.parseError) {
          ctx.push({
            role: 'tool',
            content: `Error: ${call.parseError}. Please retry with valid JSON arguments.`,
            toolCallId: call.id,
          })
          continue
        }

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
        const limit = tool.maxOutputChars ?? defaultMaxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
        try {
          const toolResult = await tool.execute(call.arguments as any, ctx)
          const content =
            typeof toolResult === 'string'
              ? toolResult
              : JSON.stringify(toolResult)

          ctx.push({
            role: 'tool',
            content: truncate(content, limit),
            toolCallId: call.id,
          })

          // Hook: after (receives raw, untruncated result)
          if (onAfterToolCall) {
            onAfterToolCall(tool, call.arguments, toolResult)
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          ctx.push({
            role: 'tool',
            content: truncate(`Error: ${message}`, limit),
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
