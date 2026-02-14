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
