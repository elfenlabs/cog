/**
 * Cog v2 — Core Types
 */

// ── Messages ────────────────────────────────────────────────────────────────

/** A tool call request from the model */
export type ToolCallRequest = {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** A message in the context chain */
export type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: ToolCallRequest[]
}

// ── Tool Schema ─────────────────────────────────────────────────────────────

/** Parameter definition for a tool */
export type ToolParameter = {
  type: 'string' | 'number' | 'boolean'
  description: string
  required?: boolean
}

/** Tool specification sent to the provider */
export type ToolSpec = {
  name: string
  description: string
  parameters: Record<string, ToolParameter>
}

// ── Provider ────────────────────────────────────────────────────────────────

/** Result from a provider generate call */
export type GenerateResult = {
  content?: string
  toolCalls?: ToolCallRequest[]
}

/** LLM provider interface — user-supplied */
export interface Provider {
  generate(params: {
    messages: Message[]
    tools?: ToolSpec[]
    signal?: AbortSignal
  }): Promise<GenerateResult>
}
