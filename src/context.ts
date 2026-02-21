/**
 * Cog v2 — Context
 *
 * Append-only message chain. Push messages in, serialize out.
 */

import type { Message } from './types.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type SerializedContext = {
  messages: Message[]
}

export type ContextOptions = {
  /** Restore from a serialized snapshot */
  from?: SerializedContext
}

// ── Context ─────────────────────────────────────────────────────────────────

export class Context {
  private _parent: Context | null = null
  private _messages: Message[]

  constructor(opts?: ContextOptions) {
    this._messages = opts?.from ? structuredClone(opts.from.messages) : []
  }

  /**
   * Create a child context linked to this one (zero-copy).
   * The child sees all parent messages as a read-only prefix
   * and appends only to its own message array.
   */
  fork(): Context {
    const child = new Context()
    child._parent = this
    return child
  }

  /** All messages in the chain (parent + own) */
  get messages(): readonly Message[] {
    return this._parent
      ? [...this._parent.messages, ...this._messages]
      : this._messages
  }

  /**
   * Push a message onto the chain.
   * - String → user message
   * - Message object → stored as-is
   */
  push(content: string | Message): void {
    if (typeof content === 'string') {
      this._messages.push({ role: 'user', content })
    } else {
      this._messages.push(content)
    }
  }

  /**
   * Pin a message at the given index (relative to own _messages).
   * Supports negative indices (-1 = last pushed).
   */
  pin(index: number): void {
    const resolved = index < 0 ? this._messages.length + index : index
    if (resolved < 0 || resolved >= this._messages.length) {
      throw new RangeError(`pin index ${index} out of range (own messages: ${this._messages.length})`)
    }
    this._messages[resolved]!.pinned = true
  }

  /**
   * Unpin a message at the given index (relative to own _messages).
   * Supports negative indices (-1 = last pushed).
   */
  unpin(index: number): void {
    const resolved = index < 0 ? this._messages.length + index : index
    if (resolved < 0 || resolved >= this._messages.length) {
      throw new RangeError(`unpin index ${index} out of range (own messages: ${this._messages.length})`)
    }
    delete this._messages[resolved]!.pinned
  }

  /**
   * Remove messages by flattened index (as seen in .messages).
   * Only owned messages can be evicted — parent messages are immutable.
   * Indices that refer to parent messages will throw.
   */
  evict(indices: number[]): void {
    if (indices.length === 0) return
    const parentLen = this._parent ? this._parent.messages.length : 0
    const localIndices = new Set<number>()

    for (const idx of indices) {
      if (idx < parentLen) {
        throw new RangeError(
          `Cannot evict index ${idx}: belongs to parent context (parent has ${parentLen} messages)`,
        )
      }
      localIndices.add(idx - parentLen)
    }

    this._messages = this._messages.filter((_, i) => !localIndices.has(i))
  }

  /** Serialize to a JSON-safe flattened snapshot */
  serialize(): SerializedContext {
    const all = this._parent
      ? [...this._parent.messages, ...this._messages]
      : this._messages
    return { messages: structuredClone(all) }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createContext(opts?: ContextOptions): Context {
  return new Context(opts)
}
