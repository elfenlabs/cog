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
  private _messages: Message[]

  constructor(opts?: ContextOptions) {
    this._messages = opts?.from ? structuredClone(opts.from.messages) : []
  }

  /** All messages in the chain (readonly copy) */
  get messages(): readonly Message[] {
    return this._messages
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

  /** Serialize to a JSON-safe snapshot */
  serialize(): SerializedContext {
    return { messages: structuredClone(this._messages) }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createContext(opts?: ContextOptions): Context {
  return new Context(opts)
}
