# 🧠 Cog — Agent SDK

An unopinionated agent framework for TypeScript. Two primitives, zero opinions on your LLM provider, prompt format, or orchestration strategy.

```
npm install cog
```

## Core Primitives

| Primitive | What it does |
|---|---|
| **Context Chain** | Ordered collection of context nodes with pinning rules. You control what the LLM sees. |
| **Control Flow Graph** | Declarative state machine. Nodes are actions (LLM call, tool, router, subgraph), edges are transitions. |

## Quick Start

```typescript
import {
  ContextChain,
  defineGraph,
  GraphRuntime,
  key,
} from 'cog'
import type {
  LLMProvider,
  LLMResult,
  LLMCallNodeConfig,
  RouterNodeConfig,
  ToolCallNodeConfig,
  ToolDefinition,
  ContextFormatter,
} from 'cog'

// 1. Define your LLM provider (OpenAI, Anthropic, vLLM, Ollama, etc.)
const llm: LLMProvider = {
  async generate(params) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: params.context,
        tools: params.tools?.map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: {
              type: 'object',
              properties: Object.fromEntries(
                Object.entries(t.parameters).map(([k, v]) => [k, { type: v.type }]),
              ),
            },
          },
        })),
      }),
    })
    const data = await res.json()
    const msg = data.choices[0].message
    return {
      content: msg.content ?? '',
      toolCalls: msg.tool_calls?.map(tc => ({
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      })),
    }
  },
}

// 2. Define a context formatter (how the chain becomes LLM input)
const formatter: ContextFormatter<Array<{ role: string; content: string }>> = (nodes) =>
  nodes.map((n, i) => ({
    role: i === 0 && n.pin.type === 'head' ? 'system' : 'user',
    content: String(n.content),
  }))

// 3. Build a graph
const graph = defineGraph({
  nodes: {
    think: {
      type: 'llm', id: 'think',
      instructions: 'Answer the question or use tools.',
      next: [{ to: 'done' }],
    } satisfies LLMCallNodeConfig,
    done: {
      type: 'llm', id: 'done',
      instructions: 'Summarize.',
    } satisfies LLMCallNodeConfig,
  },
  entryNode: 'think',
  terminalNodes: ['done'],
})

// 4. Run
const chain = new ContextChain()
chain.insert('You are a helpful assistant.', { type: 'head' })
chain.insert('What is 2 + 2?')

const runtime = new GraphRuntime()
const result = await runtime.run(graph, chain, {
  llmProvider: llm,
  contextFormatter: formatter,
})

console.log(result.finalNodeId) // 'done'
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Your Agent                         │
├─────────────────────────────────────────────────────────┤
│  Runtime Layer    GraphRuntime, SideChannel, Errors      │
│  Graph Layer      Nodes, Transitions, ToolRegistry       │
│  Context Layer    ContextChain, PinRules, Formatters     │
└─────────────────────────────────────────────────────────┘
```

## Context Chain

The context chain manages what the LLM sees. Nodes are ordered by **pin rules**:

```typescript
const chain = new ContextChain()

// Head: always first (system prompts, instructions)
chain.insert('You are a helpful assistant.', { type: 'head' })

// Tail: always last (output formatting, reminders)
chain.insert('Respond in JSON.', { type: 'tail' })

// Floating: fills the middle (conversation, tool results)
const msg = chain.insert('What is the capital of France?')

// Relative: position relative to another node
chain.insert('Important context about France.', { type: 'before', ref: msg })

// Update in place
chain.update(msg, 'What is the capital of Japan?')

// Build into any format your LLM expects
const messages = chain.build(formatter)
```

### Priority

Head and tail nodes can have priority (lower = closer to the edge):

```typescript
chain.insert('CRITICAL SAFETY RULES', { type: 'head', priority: 0 })
chain.insert('System prompt', { type: 'head', priority: 10 })
// → CRITICAL SAFETY RULES comes first
```

### Serialization

```typescript
const snapshot = chain.serialize()
const restored = ContextChain.deserialize(snapshot)
```

## Graph Definition

A graph is a set of **action nodes** connected by **transitions**:

```typescript
const graph = defineGraph({
  tools: [searchTool, calculatorTool], // graph-wide tools

  nodes: {
    analyze: {
      type: 'llm', id: 'analyze',
      instructions: 'Analyze the input.',
      next: [{ to: 'route' }],
    } satisfies LLMCallNodeConfig,

    route: {
      type: 'router', id: 'route',
      route: (result, sideChannel) => {
        const r = result as LLMResult
        return r.toolCalls?.length ? 'tool' : 'done'
      },
      next: [
        { to: 'executeTool', on: 'tool' },
        { to: 'respond', on: 'done' },
      ],
    } satisfies RouterNodeConfig,

    executeTool: {
      type: 'tool', id: 'executeTool',
      execute: async (input, ctx) => {
        // run tool, add result to ctx.chain
        return result
      },
      next: [{ to: 'analyze' }], // loop back
    } satisfies ToolCallNodeConfig,

    respond: {
      type: 'llm', id: 'respond',
      instructions: 'Provide the final answer.',
    } satisfies LLMCallNodeConfig,
  },

  entryNode: 'analyze',
  terminalNodes: ['respond'],
})
```

### Node Types

| Type | Purpose |
|---|---|
| `llm` | Calls the LLM provider with the current context |
| `tool` | Executes arbitrary code (API calls, computation, etc.) |
| `router` | Inspects the last result and picks the next path |
| `subgraph` | Runs a nested graph (isolated or inherited context) |

### Transition Guards

Route based on output content, not just labels:

```typescript
next: [
  {
    to: 'handleTools',
    when: (output) => (output as LLMResult).toolCalls?.length > 0,
  },
  { to: 'done' }, // default fallback
]
```

### Scratch Nodes

Temporary context that lives only during a node's execution:

```typescript
{
  type: 'llm', id: 'analyze',
  instructions: 'Analyze the raw data.',
  scratchNodes: [{
    content: 'RAW DATA: ...',
    collapseOnExit: async (content) => `Summary: ${content.slice(0, 100)}`,
  }],
}
// The raw data is visible during execution, then collapsed to a summary
```

### Visualizer

Inspect the graph topology before execution:

```typescript
import { visualize } from 'cog'

console.log(visualize(graph, 'ascii'))
// ┌─────────────────────────────────────┐
// │          Control Flow Graph          │
// ├─────────────────────────────────────┤
// │  🤖 analyze [ENTRY]
// │    └→ route
// │  🔀 route
// │    ├→ executeTool [tool]
// │    └→ respond [done]
// │  🔧 executeTool
// │    └→ analyze
// │  🤖 respond [TERMINAL]
// └─────────────────────────────────────┘

console.log(visualize(graph, 'mermaid'))
// graph TD
//   analyze["🤖 analyze"] --> route["🔀 route"]
//   route -->|tool| executeTool["🔧 executeTool"]
//   ...
```

## Runtime

```typescript
const runtime = new GraphRuntime()
const result = await runtime.run(graph, chain, {
  llmProvider: myProvider,
  contextFormatter: myFormatter,

  // Limits
  maxSteps: 20,
  signal: abortController.signal,

  // Error handling
  onError: 'transition', // or 'throw'
  errorNode: 'handleError',

  // Observability
  onNodeEnter: (id) => console.log(`▶ ${id}`),
  onNodeExit: (id, result) => console.log(`◀ ${id}`),
  onTransition: (from, to) => console.log(`${from} → ${to}`),
})

result.finalNodeId  // which terminal node was reached
result.steps        // how many nodes were executed
result.sideChannel  // inter-node communication data
result.chain        // the final context chain
```

## SideChannel

Type-safe key-value store for inter-node communication:

```typescript
import { SideChannel, key } from 'cog'

const issueCount = key<number>('issueCount')
const findings = key<string[]>('findings')

// In a tool node:
ctx.sideChannel.set(issueCount, 3)
ctx.sideChannel.set(findings, ['unused import', 'missing type'])

// In a later node:
const count = ctx.sideChannel.get(issueCount) // number | undefined
```

## Tool Scoping

Tools can be scoped at different levels:

```typescript
defineGraph({
  tools: [globalTool],     // available to all nodes
  nodes: {
    analyze: {
      type: 'llm', id: 'analyze',
      tools: [specialTool], // only available in this node
      toolScope: 'node',    // 'node' or 'subgraph' (default)
    },
  },
})
```

Child tools override parent tools with the same name.

## License

MIT
