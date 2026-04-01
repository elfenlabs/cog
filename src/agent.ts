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
import { estimateContentTokens } from './types.js'
import { AgentRunHandle } from './handle.js'
import type { ActiveToolCall } from './handle.js'

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
  /** Fires when the model begins streaming a tool call (name available) */
  onToolCall?: (index: number, id: string, name: string) => void
  /** Fires for each argument JSON fragment for a streamed tool call */
  onToolCallArgs?: (index: number, argChunk: string) => void
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
  /** Raw structured payload when a terminal tool ended the loop */
  terminalToolResult?: unknown
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
function messageTokenCost(msg: Message, tokenCounter: TokenCounter, includeReasoning: boolean): number {
  let tokens = estimateContentTokens(msg.content, tokenCounter)
  if (includeReasoning && msg.reasoning) tokens += tokenCounter(msg.reasoning)
  if (msg.toolCalls) tokens += tokenCounter(JSON.stringify(msg.toolCalls))
  if (msg.toolCallId) tokens += tokenCounter(msg.toolCallId)
  return tokens
}

/** Calculate the fixed token cost (instruction + tools + pinned messages) */
function calculateFixedCost(
  instruction: string,
  toolSpecs: ToolSpec[],
  ctx: Context,
  tokenCounter: TokenCounter,
  includeReasoning: boolean,
): number {
  let cost = tokenCounter(instruction)
  if (toolSpecs.length > 0) {
    cost += tokenCounter(JSON.stringify(toolSpecs))
  }
  for (const msg of ctx.messages) {
    if (msg.pinned) {
      cost += messageTokenCost(msg, tokenCounter, includeReasoning)
    }
  }
  return cost
}

// ── Single Tool Execution ───────────────────────────────────────────────────

type ToolCallResult = {
  toolCallId: string
  content: string
  rawResult?: unknown
  tool?: Tool<any>
  args?: Record<string, unknown>
}

async function executeSingleTool(
  call: { id: string; name: string; arguments: Record<string, unknown>; parseError?: string },
  toolMap: Map<string, Tool<any>>,
  ctx: Context,
  limit: number,
  onBeforeToolCall?: AgentConfig['onBeforeToolCall'],
): Promise<ToolCallResult> {
  // Handle malformed tool call arguments from model
  if (call.parseError) {
    return {
      toolCallId: call.id,
      content: `Error: ${call.parseError}. Please retry with valid JSON arguments.`,
    }
  }

  const tool = toolMap.get(call.name)
  if (!tool) {
    return {
      toolCallId: call.id,
      content: `Error: unknown tool "${call.name}"`,
    }
  }

  // Hook: before
  if (onBeforeToolCall) {
    const allowed = await onBeforeToolCall(tool, call.arguments)
    if (allowed === false) {
      return {
        toolCallId: call.id,
        content: 'Error: tool call was blocked',
        tool,
        args: call.arguments,
      }
    }
  }

  // Execute the tool
  const toolLimit = tool.maxOutputChars ?? limit
  try {
    const toolResult = await tool.execute(call.arguments as any, ctx)
    const content =
      typeof toolResult === 'string'
        ? toolResult
        : JSON.stringify(toolResult)

    return {
      toolCallId: call.id,
      content: truncate(content, toolLimit),
      rawResult: toolResult,
      tool,
      args: call.arguments,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      toolCallId: call.id,
      content: truncate(`Error: ${message}`, toolLimit),
      tool,
      args: call.arguments,
    }
  }
}

// ── Agent Loop ──────────────────────────────────────────────────────────────

async function executeLoop(
  config: AgentConfig,
  handle: AgentRunHandle,
): Promise<AgentResult> {
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
    onToolCall,
    onToolCallArgs,
    onBeforeToolCall,
    onAfterToolCall,
  } = config

  const toolMap = new Map(tools.map(t => [t.id, t]))
  const toolSpecs = tools.map(t => t.spec)

  let steps = 0
  let isThinking = false
  let isOutputting = false
  const totalUsage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  const outputLimit = defaultMaxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS

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

  try {
    while (true) {
      // Check abort
      if (signal?.aborted) {
        throw new AgentAbortError()
      }

      // Check step limit
      if (steps >= maxSteps) {
        throw new MaxStepsError(maxSteps)
      }

      // Transition: thinking
      handle._transition('thinking', steps)

      // Compact context if strategy is configured
      if (evictionStrategy) {
        const includeReasoning = provider.includesReasoning ?? false
        const fixedCost = calculateFixedCost(instruction, toolSpecs, ctx, tokenCounter, includeReasoning)
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
      const wrappedOnThinking = (onThinking || onThinkingStart || onThinkingEnd)
        ? (chunk: string) => {
            if (!isThinking) {
              isThinking = true
              onThinkingStart?.()
            }
            onThinking?.(chunk)
          }
        : undefined

      const wrappedOnOutput = (onOutput || onOutputStart || onOutputEnd)
        ? (chunk: string) => {
            if (!isOutputting) {
              isOutputting = true
              endThinking()
              onOutputStart?.()
            }
            onOutput?.(chunk)
          }
        : undefined

      const stream: StreamCallbacks | undefined =
        wrappedOnThinking || wrappedOnOutput || onToolCall || onToolCallArgs
          ? {
              onReasoning: wrappedOnThinking,
              onContent: wrappedOnOutput,
              onToolCallStart: onToolCall,
              onToolCallDelta: onToolCallArgs,
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

      // Case 1: Model returned tool calls → execute in parallel and loop
      if (result.toolCalls && result.toolCalls.length > 0) {
        endThinking()
        endOutput()

        // Transition: tool_call
        handle._transition('tool_call', steps)

        // Append the assistant message with tool calls to context
        ctx.push({
          role: 'assistant',
          content: result.content ?? '',
          reasoning: result.reasoning,
          toolCalls: result.toolCalls,
        })

        // Register active tool calls on the handle
        handle._setActiveToolCalls(
          result.toolCalls.map(call => ({
            id: call.id,
            toolId: call.name,
            args: call.arguments,
            startedAt: new Date(),
          })),
        )

        // Execute all tool calls in parallel
        const toolResults = await Promise.allSettled(
          result.toolCalls.map(call =>
            executeSingleTool(call, toolMap, ctx, outputLimit, onBeforeToolCall),
          ),
        )

        // Clear active tool calls
        handle._clearActiveToolCalls()

        // Push all results into context
        for (const settled of toolResults) {
          if (settled.status === 'fulfilled') {
            const tr = settled.value
            ctx.push({
              role: 'tool',
              content: tr.content,
              toolCallId: tr.toolCallId,
            })

            // Hook: after (only for successful executions with a raw result)
            if (onAfterToolCall && tr.rawResult !== undefined && tr.tool) {
              onAfterToolCall(tr.tool, tr.args!, tr.rawResult)
            }
          } else {
            // Unexpected rejection — should not happen since executeSingleTool catches errors
            ctx.push({
              role: 'tool',
              content: `Error: ${settled.reason}`,
              toolCallId: 'unknown',
            })
          }
        }

        // Check for terminal tool — short-circuit the loop
        const terminalResult = toolResults.find(
          s => s.status === 'fulfilled' && s.value.tool?.terminal,
        )
        if (terminalResult && terminalResult.status === 'fulfilled') {
          const tr = terminalResult.value
          handle._transition('done', steps)
          return {
            response: tr.content,
            steps,
            usage: totalUsage,
            terminalToolResult: tr.rawResult,
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
        handle._transition('done', steps)
        return { response: result.content, steps, usage: totalUsage }
      }

      // Case 3: Reasoning only (no content, no tool calls) — continue loop
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
  } catch (err) {
    handle._transition('error', steps)
    throw err
  }
}

export function runAgent(config: AgentConfig): AgentRunHandle {
  const handle = new AgentRunHandle()
  handle._start(() => executeLoop(config, handle))
  return handle
}
