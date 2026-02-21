# 🧠 Cog

A minimal agent SDK for TypeScript. Three primitives, zero opinions on your LLM provider.

```
npm install @elfenlabs/cog
```

## Quick Start

```typescript
import { createContext, createTool, createOpenAIProvider, runAgent } from '@elfenlabs/cog'

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
| **Agent** | The loop. Calls the provider, executes tool calls, repeats until the model responds with text. |

## Context

An ordered `Message[]` chain. Push strings (become `user` messages) or full `Message` objects.

```typescript
import { createContext } from '@elfenlabs/cog'

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
import { createTool } from '@elfenlabs/cog'

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

## Agent Loop

`runAgent` calls the provider in a loop, executing tool calls until the model responds with text only.

```typescript
import { runAgent } from '@elfenlabs/cog'

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
import { createOpenAIProvider } from '@elfenlabs/cog'

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

Agents are just functions. Wrap `runAgent` inside a tool to create sub-agents with isolated context.

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

    // Only the final answer bubbles up — no pagination noise in parent context
    return result.response
  },
})

// Parent agent uses the sub-agent as a regular tool
const result = await runAgent({
  ctx: createContext(),
  provider,
  instruction: 'Use search_orders to look up order information.',
  tools: [searchOrders],
})
```

## Context Window Management

LLM APIs have context limits. When the conversation exceeds the limit, some providers return a 400 error — others **silently truncate from the beginning**, evicting your system prompt first. Cog prevents this with automatic compaction.

### Automatic Compaction

Pass an `evictionStrategy` to `runAgent` and Cog will compact the context before every `generate()` call:

```typescript
import { runAgent, SlidingWindowStrategy } from '@elfenlabs/cog'

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
import { SlidingWindowStrategy } from '@elfenlabs/cog'

const strategy = new SlidingWindowStrategy()
const tokenCounter = (text: string) => text.length / 4

// Proactive compaction at 50% to fight context rot
strategy.compact(ctx, maxTokens * 0.5, tokenCounter)
```

### Custom Strategies

Implement the `EvictionStrategy` interface for custom behavior:

```typescript
import type { EvictionStrategy, TokenCounter } from '@elfenlabs/cog'
import type { Context } from '@elfenlabs/cog'

class SummarizingStrategy implements EvictionStrategy {
  compact(ctx: Context, budgetTokens: number, tokenCounter: TokenCounter): void {
    // Your logic: summarize old messages, evict, push summary, etc.
  }
}
```

## Error Handling

```typescript
import { MaxStepsError, AgentAbortError, ContextBudgetError } from '@elfenlabs/cog'

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

Unknown tool calls and tool execution errors are automatically caught and fed back to the model as `tool` messages, letting it recover gracefully.

## License

MIT
