/**
 * Cog — OpenAI-compatible Provider
 *
 * Works with OpenAI, vLLM, OpenRouter, and any OpenAI-compatible API.
 * Supports streaming (SSE) with reasoning_content extraction.
 */

import type { Provider, ToolCallRequest, StreamCallbacks, Message, ToolSpec, Usage } from '../types.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type OpenAIProviderOptions = {
  /** API key for authentication (sent as Bearer token) */
  apiKey?: string
  /** Temperature for generation (default: 0.7) */
  temperature?: number
}

// ── Message Conversion ──────────────────────────────────────────────────────

/** Convert internal Cog messages to OpenAI API wire format */
function toAPIMessages(messages: Message[]) {
  return messages.map(m => {
    const msg: Record<string, unknown> = { role: m.role, content: m.content }
    if (m.toolCallId) msg.tool_call_id = m.toolCallId
    if (m.toolCalls) {
      msg.tool_calls = m.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }))
    }
    return msg
  })
}

/** Convert internal Cog tool specs to OpenAI function-calling format */
function toAPITools(tools: ToolSpec[]) {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(t.parameters).map(([k, v]) => [
            k,
            { type: v.type, description: v.description },
          ]),
        ),
        required: Object.entries(t.parameters)
          .filter(([_, v]) => v.required !== false)
          .map(([k]) => k),
      },
    },
  }))
}

/** Parse tool calls from a non-streaming response message */
function parseToolCalls(toolCalls: any[] | undefined): ToolCallRequest[] | undefined {
  if (!toolCalls) return undefined
  return toolCalls.map((tc: any) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: JSON.parse(tc.function.arguments),
  }))
}

// ── SSE Streaming ───────────────────────────────────────────────────────────

async function readSSEStream(
  response: Response,
  stream: StreamCallbacks | undefined,
) {
  let content = ''
  let reasoning = ''
  let usage: Usage | undefined
  const toolCallsMap = new Map<number, { id: string; name: string; args: string }>()

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()!

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (payload === '[DONE]') continue

      const chunk = JSON.parse(payload)

      // Usage arrives in the final chunk (when stream_options.include_usage is set)
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
          totalTokens: chunk.usage.total_tokens ?? 0,
        }
      }

      const delta = chunk.choices?.[0]?.delta
      if (!delta) continue

      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content
        stream?.onReasoning?.(delta.reasoning_content)
      }
      if (delta.content) {
        content += delta.content
        stream?.onContent?.(delta.content)
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          if (!toolCallsMap.has(idx)) {
            toolCallsMap.set(idx, { id: tc.id ?? '', name: '', args: '' })
          }
          const entry = toolCallsMap.get(idx)!
          if (tc.id) entry.id = tc.id
          if (tc.function?.name) entry.name += tc.function.name
          if (tc.function?.arguments) entry.args += tc.function.arguments
        }
      }
    }
  }

  const toolCalls: ToolCallRequest[] | undefined =
    toolCallsMap.size > 0
      ? Array.from(toolCallsMap.values()).map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: JSON.parse(tc.args || '{}'),
        }))
      : undefined

  return {
    content: content || undefined,
    reasoning: reasoning || undefined,
    toolCalls,
    usage,
  }
}

// ── Provider Factory ────────────────────────────────────────────────────────

/**
 * Create a provider for any OpenAI-compatible API.
 *
 * Works with: OpenAI, vLLM, OpenRouter, Ollama, LiteLLM, etc.
 *
 * @example
 * ```ts
 * const provider = createOpenAIProvider('https://api.openai.com', 'gpt-4o')
 * const provider = createOpenAIProvider('http://localhost:8000', 'my-model')
 * const provider = createOpenAIProvider('https://openrouter.ai/api', 'anthropic/claude-sonnet-4.5', {
 *   apiKey: 'sk-or-...',
 *   temperature: 0.2,
 * })
 * ```
 */
export function createOpenAIProvider(
  baseUrl: string,
  model: string,
  opts?: OpenAIProviderOptions,
): Provider {
  const temperature = opts?.temperature ?? 0.7

  return {
    async generate(params) {
      const shouldStream = !!(params.stream?.onReasoning || params.stream?.onContent)

      const body: Record<string, unknown> = {
        model,
        messages: toAPIMessages(params.messages),
        temperature,
        stream: shouldStream,
        ...(shouldStream ? { stream_options: { include_usage: true } } : {}),
      }

      const tools = params.tools && params.tools.length > 0 ? toAPITools(params.tools) : undefined
      if (tools) {
        body.tools = tools
        body.tool_choice = 'auto'
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (opts?.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: params.signal,
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`LLM request failed (${response.status}): ${text}`)
      }

      // Non-streaming path
      if (!shouldStream) {
        const data = (await response.json()) as any
        const message = data.choices[0].message
        const usage: Usage | undefined = data.usage
          ? {
              promptTokens: data.usage.prompt_tokens ?? 0,
              completionTokens: data.usage.completion_tokens ?? 0,
              totalTokens: data.usage.total_tokens ?? 0,
            }
          : undefined
        return {
          content: message.content ?? undefined,
          reasoning: message.reasoning_content ?? undefined,
          toolCalls: parseToolCalls(message.tool_calls),
          usage,
        }
      }

      // Streaming path (SSE)
      return readSSEStream(response, params.stream)
    },
  }
}
