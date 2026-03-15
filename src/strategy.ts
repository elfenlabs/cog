/**
 * Nous — Eviction Strategies
 *
 * Context is pure data. Strategies operate ON the context externally.
 * This separation lets different callers use different strategies
 * on the same Context.
 */

import type { Context } from './context.js'
import type { Message } from './types.js'
import { estimateContentTokens } from './types.js'

// ── Types ───────────────────────────────────────────────────────────────────

/** Counts tokens for a given text string */
export type TokenCounter = (text: string) => number

/** Default token counter: chars / 4 heuristic (~3.5–4 chars per token for English) */
export const defaultTokenCounter: TokenCounter = (text) => text.length / 4

/** Strategy interface for context compaction */
export interface EvictionStrategy {
  /**
   * Compact the context to fit within budgetTokens.
   * Must respect pinned messages — never evict them.
   * @param ctx - The context to compact
   * @param budgetTokens - Token budget for non-fixed messages
   * @param tokenCounter - Function to count tokens for a string
   */
  compact(ctx: Context, budgetTokens: number, tokenCounter: TokenCounter): void
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Estimate the token cost of a single message */
function messageTokens(msg: Message, tokenCounter: TokenCounter): number {
  let tokens = estimateContentTokens(msg.content, tokenCounter)
  if (msg.reasoning) tokens += tokenCounter(msg.reasoning)
  if (msg.toolCalls) tokens += tokenCounter(JSON.stringify(msg.toolCalls))
  if (msg.toolCallId) tokens += tokenCounter(msg.toolCallId)
  return tokens
}

// ── SlidingWindowStrategy ───────────────────────────────────────────────────

/**
 * Evicts oldest non-pinned messages first.
 *
 * Maintains tool-call group integrity: an assistant message with toolCalls
 * is always evicted together with its corresponding tool result messages.
 * Pinned messages within a group are preserved — the rest of the group
 * is still evicted.
 */
export class SlidingWindowStrategy implements EvictionStrategy {
  compact(ctx: Context, budgetTokens: number, tokenCounter: TokenCounter): void {
    const messages = ctx.messages

    // Calculate total tokens for non-pinned messages
    let totalTokens = 0
    for (const msg of messages) {
      if (!msg.pinned) {
        totalTokens += messageTokens(msg, tokenCounter)
      }
    }

    if (totalTokens <= budgetTokens) return

    // Build eviction groups (oldest first)
    // A group is either:
    //  - A single standalone message (user, assistant without toolCalls, reasoning-only)
    //  - An assistant message with toolCalls + all corresponding tool result messages
    const groups = buildEvictionGroups(messages)

    // Evict groups oldest-first until we're within budget
    const indicesToEvict: number[] = []

    for (const group of groups) {
      if (totalTokens <= budgetTokens) break

      // Collect non-pinned indices from this group
      let groupTokens = 0
      const groupEvictable: number[] = []

      for (const idx of group) {
        if (!messages[idx]!.pinned) {
          groupEvictable.push(idx)
          groupTokens += messageTokens(messages[idx]!, tokenCounter)
        }
      }

      if (groupEvictable.length > 0) {
        indicesToEvict.push(...groupEvictable)
        totalTokens -= groupTokens
      }
    }

    if (indicesToEvict.length > 0) {
      ctx.evict(indicesToEvict)
    }
  }
}

// ── Group Builder ───────────────────────────────────────────────────────────

/**
 * Build eviction groups from a message array.
 * Each group is an array of flattened indices that must be evicted together.
 */
function buildEvictionGroups(messages: readonly Message[]): number[][] {
  const groups: number[][] = []
  // Track which tool result indices are already claimed by a group
  const claimed = new Set<number>()

  // Build a map of toolCallId → message index for fast lookup
  const toolResultMap = new Map<string, number[]>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.role === 'tool' && msg.toolCallId) {
      const existing = toolResultMap.get(msg.toolCallId)
      if (existing) {
        existing.push(i)
      } else {
        toolResultMap.set(msg.toolCallId, [i])
      }
    }
  }

  for (let i = 0; i < messages.length; i++) {
    if (claimed.has(i)) continue

    const msg = messages[i]!

    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      // Group: assistant + all its tool results
      const group = [i]
      for (const tc of msg.toolCalls) {
        const resultIndices = toolResultMap.get(tc.id)
        if (resultIndices) {
          for (const ri of resultIndices) {
            group.push(ri)
            claimed.add(ri)
          }
        }
      }
      groups.push(group)
    } else if (!claimed.has(i)) {
      // Standalone message
      groups.push([i])
    }
  }

  return groups
}
