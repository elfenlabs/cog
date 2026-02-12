/**
 * Graph Layer — Types
 *
 * LLM provider, tool definitions, and shared types for the graph layer.
 */

// ---------------------------------------------------------------------------
// LLM Provider (user-provided)
// ---------------------------------------------------------------------------

export interface LLMProvider {
  generate(params: LLMRequest): Promise<LLMResult>
}

export interface LLMRequest {
  context: unknown
  tools?: ToolDefinition[]
  onChunk?: (chunk: string) => void
}

export interface LLMResult {
  content: string
  toolCalls?: ToolCall[]
  metadata?: Record<string, unknown>
}

export interface ToolCall {
  name: string
  arguments: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

export interface ParameterDef {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description?: string
  required?: boolean
}

export interface ToolDefinition<TArgs = any, TResult = any> {
  name: string
  description: string
  parameters: Record<string, ParameterDef>
  validate?: (args: unknown) => args is TArgs
  execute: (args: TArgs) => Promise<TResult>
}
