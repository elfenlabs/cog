/**
 * Cog v2 — Core Types
 */

// ── Messages ────────────────────────────────────────────────────────────────

/** A tool call request from the model */
export type ToolCallRequest = {
  id: string
  name: string
  arguments: Record<string, unknown>
  /** Present when the model produced invalid JSON for arguments */
  parseError?: string
}

/** A message in the context chain */
export type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoning?: string
  toolCallId?: string
  toolCalls?: ToolCallRequest[]
}

// ── Tool Schema ─────────────────────────────────────────────────────────────

/** Parameter definition for a tool */
export type ToolParameter = {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description: string
  required?: boolean
  /** For 'object' — nested parameter definitions */
  properties?: Record<string, ToolParameter>
  /** For 'array' — schema of each array element */
  items?: ToolParameter
  /** For 'string' — restrict to an explicit set of values */
  enum?: string[]
}

/** Tool specification sent to the provider */
export type ToolSpec = {
  name: string
  description: string
  parameters: Record<string, ToolParameter>
}

// ── Provider ────────────────────────────────────────────────────────────────

/** Token usage statistics from a provider call */
export type Usage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Result from a provider generate call */
export type GenerateResult = {
  content?: string
  reasoning?: string
  toolCalls?: ToolCallRequest[]
  usage?: Usage
}

/** Streaming callbacks passed to the provider */
export type StreamCallbacks = {
  onReasoning?: (chunk: string) => void
  onContent?: (chunk: string) => void
}

/** LLM provider interface — user-supplied */
export interface Provider {
  generate(params: {
    messages: Message[]
    tools?: ToolSpec[]
    signal?: AbortSignal
    stream?: StreamCallbacks
  }): Promise<GenerateResult>
}
