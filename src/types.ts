/**
 * Nous — Core Types
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

/** A single part of a multi-part message (OpenAI vision/audio format) */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
  | { type: 'input_audio'; input_audio: { data: string; format: 'wav' | 'mp3' } }
  | { type: 'video_url'; video_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
  | { type: 'file'; file: { url: string; mime_type: string; name?: string } }

/** A message in the context chain */
export type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  reasoning?: string
  toolCallId?: string
  toolCalls?: ToolCallRequest[]
  /** When true, this message is protected from eviction */
  pinned?: boolean
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
  /** Fires once when a new tool call index first appears in the stream */
  onToolCallStart?: (index: number, id: string, name: string) => void
  /** Fires for each argument JSON fragment on an existing tool call */
  onToolCallDelta?: (index: number, argChunk: string) => void
}

/** LLM provider interface — user-supplied */
export interface Provider {
  generate(params: {
    messages: Message[]
    tools?: ToolSpec[]
    signal?: AbortSignal
    stream?: StreamCallbacks
  }): Promise<GenerateResult>
  /** MIME patterns this provider handles natively. Omission = text-only. */
  supportedMedia?: string[]
}

// ── Content Helpers ─────────────────────────────────────────────────────────

/** Extract the text representation from string or ContentPart[] content */
export function contentText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map(p => p.text)
    .join('\n')
}

/**
 * Estimate token cost of image content using OpenAI's tile formula.
 * Without actual pixel dimensions we assume the default 4-tile case (2×2 grid).
 *
 * - `low`          → 85 tokens
 * - `high`/`auto`  → 85 base + 4 tiles × 170 = 765 tokens
 * - omitted        → treated as `high` (conservative)
 */
function estimateImageTokens(detail?: 'low' | 'high' | 'auto'): number {
  if (detail === 'low') return 85
  return 85 + 4 * 170 // 765
}

/** Estimate token cost of content (string or ContentPart[]) */
export function estimateContentTokens(
  content: string | ContentPart[],
  tokenCounter: (text: string) => number,
): number {
  if (typeof content === 'string') return tokenCounter(content)
  return content.reduce((sum, part) => {
    if (part.type === 'text') return sum + tokenCounter(part.text)
    if (part.type === 'image_url') return sum + estimateImageTokens(part.image_url.detail)
    if (part.type === 'input_audio') return sum + Math.ceil(part.input_audio.data.length / 4)
    if (part.type === 'video_url') return sum + 765
    if (part.type === 'file') return sum + 1000
    return sum
  }, 0)
}
