# 🧠 Nous

A minimal agent SDK for TypeScript. Four primitives, zero opinions on your LLM provider.

```
npm install @elfenlabs/nous
```

## Quick Start

```typescript
import { createContext, createTool, createOpenAIProvider, runAgent } from '@elfenlabs/nous'

// Define a tool
const getWeather = createTool({
  id: 'get_weather',
  description: 'Get the current weather for a city',
  schema: {
    city: { type: 'string', description: 'The city name' },
  },
  execute: async (args) => {
    const { city } = args as { city: string }
    return { city, temp: 22, condition: 'sunny' }
  },
})

// Create context and provider
const ctx = createContext()
ctx.push("What's the weather in Tokyo?")

const provider = createOpenAIProvider('https://api.openai.com', 'gpt-4o', {
  apiKey: process.env.OPENAI_API_KEY,
})

// Run the agent
const result = await runAgent({
  ctx,
  provider,
  instruction: 'You are a helpful assistant. Use tools when needed.',
  tools: [getWeather],
})

console.log(result.response) // "The weather in Tokyo is 22°C and sunny."
console.log(result.steps)    // 2
console.log(result.usage)    // { promptTokens, completionTokens, totalTokens }
```

## Primitives

| Primitive | What it is |
|---|---|
| **Context** | Append-only message chain. You push messages in, the agent loop reads them out. |
| **Tool** | Schema + execute function. The agent calls tools automatically based on model output. |
| **Provider** | LLM backend interface. A single `generate()` method — implement it for any API. |
| **Agent** | The loop. Calls the provider, executes tool calls, repeats until the model responds with text. |

## Context

An ordered `Message[]` chain. Push strings (become `user` messages) or full `Message` objects.

```typescript
import { createContext } from '@elfenlabs/nous'

const ctx = createContext()

// Strings become user messages
ctx.push('What is 2 + 2?')

// Full messages for other roles
ctx.push({ role: 'system', content: 'You are a math tutor.' })

// Read messages
ctx.messages // readonly Message[]

// Serialize / restore
const snapshot = ctx.serialize()
const restored = createContext({ from: snapshot })

// Fork — zero-copy child context (see Sub-Agent Composition)
const child = ctx.fork()
child.push('This message only exists in the child')
child.messages  // [...parent messages, child messages]
ctx.messages    // unchanged — parent is not affected
```

### Message Shape

```typescript
type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoning?: string        // chain-of-thought from reasoning models
  toolCallId?: string       // links tool results back to the call
  toolCalls?: ToolCallRequest[]  // tool calls requested by the model
  pinned?: boolean          // protected from eviction (see Context Window Management)
}
```

## Tool

A tool is an `id`, a `description`, a `schema`, and an `execute` function.

```typescript
import { createTool } from '@elfenlabs/nous'

const calculator = createTool({
  id: 'calculator',
  description: 'Evaluate a math expression',
  schema: {
    expression: { type: 'string', description: 'The expression to evaluate', required: true },
  },
  execute: async (args) => {
    const { expression } = args as { expression: string }
    return { result: eval(expression) }
  },
})

// The .spec property gives you the wire format for provider APIs
calculator.spec // { name, description, parameters }
```

### Parameter Types

```typescript
type ToolParameter = {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description: string
  required?: boolean       // default: true
  properties?: Record<string, ToolParameter>  // for 'object'
  items?: ToolParameter    // for 'array'
  enum?: string[]          // for 'string'
}
```

### Output Truncation

Tool results are truncated to prevent context blowup. Set a default limit on the agent, or override per-tool:

```typescript
const result = await runAgent({
  ctx,
  provider,
  instruction: '...',
  tools: [myTool],
  defaultMaxOutputChars: 10_000,  // default limit for all tools
})

// Per-tool override
const bigOutputTool = createTool({
  id: 'read_file',
  description: 'Read a file',
  schema: { path: { type: 'string', description: 'File path' } },
  maxOutputChars: 50_000,  // this tool gets a larger limit
  execute: async (args) => fs.readFileSync((args as { path: string }).path, 'utf8'),
})
```

Priority: per-tool `maxOutputChars` > agent `defaultMaxOutputChars` > built-in default (10,000 chars).

## Agent Loop

`runAgent` calls the provider in a loop, executing tool calls until the model responds with text only.

```typescript
import { runAgent } from '@elfenlabs/nous'

const result = await runAgent({
  ctx,                    // Context — the conversation so far
  provider,               // Provider — any LLM backend
  instruction: '...',     // system prompt (prepended to every call)
  tools: [tool1, tool2],  // available tools

  // Limits
  maxSteps: 50,           // default: 50
  signal: abortController.signal,

  // Context window management (see below)
  maxContextTokens: 100_000,
  evictionStrategy: new SlidingWindowStrategy(),
  tokenCounter: (text) => text.length / 4,  // default

  // Streaming callbacks
  onThinkingStart: () => {},
  onThinking: (chunk) => {},      // reasoning tokens (dim/hidden)
  onThinkingEnd: () => {},
  onOutputStart: () => {},
  onOutput: (chunk) => {},        // content tokens (visible)
  onOutputEnd: () => {},

  // Tool lifecycle hooks
  onBeforeToolCall: async (tool, args) => {
    // return false to block the call
  },
  onAfterToolCall: (tool, args, result) => {},
})

result.response  // final text response
result.steps     // number of provider calls made
result.usage     // { promptTokens, completionTokens, totalTokens }
```

### Streaming

The streaming callbacks follow a lifecycle: `onThinkingStart` → `onThinking` (repeated) → `onThinkingEnd` → `onOutputStart` → `onOutput` (repeated) → `onOutputEnd`. Transitions are managed automatically — thinking ends when content begins.

```typescript
const result = await runAgent({
  ctx,
  provider,
  instruction: 'You are a helpful assistant.',
  tools,
  onThinkingStart: () => process.stdout.write('\x1b[2m'),  // dim
  onThinking: (chunk) => process.stdout.write(chunk),
  onThinkingEnd: () => process.stdout.write('\x1b[0m\n'),  // reset
  onOutputStart: () => {},
  onOutput: (chunk) => process.stdout.write(chunk),
  onOutputEnd: () => process.stdout.write('\n'),
})
```

Streaming callbacks fire during each provider call. When the model makes tool calls, `onOutputEnd` fires before tool execution, and new `onOutputStart`/`onOutput` events fire on the next iteration.

### How the Loop Works

```
┌─────────────────────────────────────────────┐
│  system prompt + ctx.messages → provider    │
│                    ↓                        │
│  ┌─ tool calls? ──────────────────────────┐ │
│  │ YES → execute tools → push results     │ │
│  │       → loop back to provider          │ │
│  ├─ text content? ────────────────────────┤ │
│  │ YES → push assistant message → return  │ │
│  ├─ reasoning only? ─────────────────────┤  │
│  │ YES → push reasoning → loop           │  │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

Each iteration, the provider returns a `GenerateResult` with optional `content`, `reasoning`, and `toolCalls`. The agent evaluates them in priority order:

**Case 1 — Tool Calls:** The model returned `toolCalls` (content and reasoning may also be present). The agent pushes the assistant message to context, then executes each tool call. Within this case, each individual call is handled as one of:

- **Parse error** — model produced invalid JSON arguments → push an error result asking the model to retry
- **Unknown tool** — model hallucinated a tool name → push an error result
- **Blocked** — `onBeforeToolCall` hook returned `false` → push a "blocked" result
- **Success** — run `tool.execute()`, truncate output to `maxOutputChars`, push result
- **Exception** — tool threw an error → catch it, push the error message as result

After all tool calls are processed, the loop **continues** back to the provider.

**Case 2 — Content only:** The model returned `content` with no tool calls. This is the **only case that exits the loop**. The agent pushes the final assistant message and returns `AgentResult`.

**Case 3 — Reasoning only:** The model returned only `reasoning` (a think block) with no content or tool calls. This happens with reasoning models that sometimes emit a think step before acting. The agent pushes an assistant message with empty content and loops again.

**Case 4 — Empty response:** No content, reasoning, or tool calls. The agent throws an error.

## Provider

The `Provider` interface is a single method. Implement it for any LLM backend.

```typescript
interface Provider {
  generate(params: {
    messages: Message[]
    tools?: ToolSpec[]
    signal?: AbortSignal
    stream?: StreamCallbacks
  }): Promise<GenerateResult>
}

type GenerateResult = {
  content?: string
  reasoning?: string
  toolCalls?: ToolCallRequest[]
  usage?: Usage
}

type StreamCallbacks = {
  onReasoning?: (chunk: string) => void
  onContent?: (chunk: string) => void
}
```

### Built-in: OpenAI-Compatible Provider

Works with OpenAI, vLLM, OpenRouter, Ollama, LiteLLM, and any OpenAI-compatible API. Supports streaming (SSE) with reasoning model support (`reasoning_content`).

```typescript
import { createOpenAIProvider } from '@elfenlabs/nous'

// OpenAI
const openai = createOpenAIProvider('https://api.openai.com', 'gpt-4o', {
  apiKey: process.env.OPENAI_API_KEY,
})

// Local vLLM
const vllm = createOpenAIProvider('http://localhost:8000', 'my-model')

// OpenRouter
const openrouter = createOpenAIProvider('https://openrouter.ai/api', 'anthropic/claude-sonnet-4.5', {
  apiKey: process.env.OPENROUTER_API_KEY,
  temperature: 0.2,
})
```

## Sub-Agent Composition

Agents are just functions. Wrap `runAgent` inside a tool to create sub-agents.

### Isolated Context

Use `createContext()` when the sub-agent doesn't need the parent conversation. Only the final answer bubbles up — no internal noise leaks into the parent.

```typescript
const searchOrders = createTool({
  id: 'search_orders',
  description: 'Search through paginated orders to find a match',
  schema: {
    query: { type: 'string', description: 'What to search for' },
  },
  execute: async (args) => {
    const { query } = args as { query: string }

    // Sub-agent gets its own isolated context
    const subCtx = createContext()
    subCtx.push(`Find: ${query}`)

    const fetchPage = createTool({
      id: 'fetch_page',
      description: 'Fetch a page of orders',
      schema: { page: { type: 'number', description: 'Page number' } },
      execute: async (a) => api.getOrders((a as { page: number }).page),
    })

    const result = await runAgent({
      ctx: subCtx,
      provider,
      instruction: 'Search through pages until you find the item or exhaust all pages.',
      tools: [fetchPage],
      maxSteps: 20,
    })

    return result.response
  },
})
```

### Forked Context

Use `ctx.fork()` when the sub-agent needs the full parent conversation to do its job. The child sees all parent messages as a read-only prefix and appends only to its own array — tool call noise stays in the fork.

```typescript
const deepAnalysis = createTool({
  id: 'deep_analysis',
  description: 'Perform deep analysis using the full conversation context',
  schema: {
    focus: { type: 'string', description: 'What aspect to analyze' },
  },
  execute: async (args, ctx) => {
    const { focus } = args as { focus: string }

    // Fork inherits the entire parent conversation (zero-copy)
    const forkedCtx = ctx.fork()
    forkedCtx.push(`Analyze the conversation so far, focusing on: ${focus}`)

    const result = await runAgent({
      ctx: forkedCtx,
      provider,
      instruction: 'You are an analyst. Use the conversation history to provide insights.',
      tools: [searchDatabase, runQuery],
      maxSteps: 15,
    })

    // Sub-agent's tool calls and intermediate steps stay in the fork
    // Only the final answer returns to the parent
    return result.response
  },
})
```

## Context Window Management

LLM APIs have context limits. When the conversation exceeds the limit, some providers return a 400 error — others **silently truncate from the beginning**, evicting your system prompt first. Nous prevents this with automatic compaction.

### Automatic Compaction

Pass an `evictionStrategy` to `runAgent` and Nous will compact the context before every `generate()` call:

```typescript
import { runAgent, SlidingWindowStrategy } from '@elfenlabs/nous'

const result = await runAgent({
  ctx,
  provider,
  instruction: 'You are a helpful assistant.',
  tools: [myTool],
  maxContextTokens: 100_000,                // token budget (default: 100k)
  evictionStrategy: new SlidingWindowStrategy(), // enable auto-compaction
})
```

`SlidingWindowStrategy` evicts the oldest non-pinned messages first. Tool call groups (assistant message + tool results) are always evicted as a unit to maintain structural integrity.

### Pinning Messages

Pin critical messages to protect them from eviction:

```typescript
const ctx = createContext()

ctx.push({ role: 'user', content: 'Project spec: build a CLI tool that...' })
ctx.pin(-1) // protect from eviction (-1 = last pushed)

ctx.push({ role: 'user', content: 'Also, here are the requirements...' })
ctx.pin(-1)

// Later, if needed:
ctx.unpin(0) // remove protection
```

Pinned messages are never evicted. The system prompt (passed as `instruction`) and tool definitions are always protected automatically — they're budgeted as fixed costs.

### Custom Token Counter

The default token estimator uses `text.length / 4` (~3.5–4 chars per token for English). For precise counting:

```typescript
import { encode } from 'tiktoken'

const result = await runAgent({
  // ...
  tokenCounter: (text) => encode(text).length,
})
```

### On-Demand Compaction

Strategies can also be called directly — by the host app, a tool, or any caller:

```typescript
import { SlidingWindowStrategy } from '@elfenlabs/nous'

const strategy = new SlidingWindowStrategy()
const tokenCounter = (text: string) => text.length / 4

// Proactive compaction at 50% to fight context rot
strategy.compact(ctx, maxTokens * 0.5, tokenCounter)
```

### Custom Strategies

Implement the `EvictionStrategy` interface for custom behavior:

```typescript
import type { EvictionStrategy, TokenCounter } from '@elfenlabs/nous'
import type { Context } from '@elfenlabs/nous'

class SummarizingStrategy implements EvictionStrategy {
  compact(ctx: Context, budgetTokens: number, tokenCounter: TokenCounter): void {
    // Your logic: summarize old messages, evict, push summary, etc.
  }
}
```

## Error Handling

### Thrown Errors

These errors propagate to the caller and must be caught:

```typescript
import { MaxStepsError, AgentAbortError, ContextBudgetError } from '@elfenlabs/nous'

try {
  await runAgent({ ctx, provider, instruction: '...', tools, maxSteps: 10 })
} catch (err) {
  if (err instanceof MaxStepsError) {
    // Agent exceeded step limit
  }
  if (err instanceof AgentAbortError) {
    // AbortSignal was triggered
  }
  if (err instanceof ContextBudgetError) {
    // Fixed context (system prompt + tools + pinned) exceeds maxContextTokens
  }
}
```

### Auto-Recovery

These errors are handled internally — the agent feeds them back to the model as `tool` role messages, giving the model a chance to self-correct:

- **Unknown tool** — model called a tool that doesn't exist (e.g., hallucinated name)
- **Malformed arguments** — model produced invalid JSON for tool arguments
- **Tool exception** — `tool.execute()` threw an error
- **Blocked call** — `onBeforeToolCall` hook returned `false`

The model sees the error in its context and can retry with corrected arguments, use a different tool, or respond with text instead. This keeps the agent loop resilient without requiring manual error handling for common LLM mistakes.

## License

MIT
