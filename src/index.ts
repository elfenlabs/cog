/**
 * Nous — A minimal agent SDK for TypeScript
 *
 * Three primitives, infinite composition.
 */

export { createContext, Context } from './context.js'
export type { ContextOptions, SerializedContext } from './context.js'

export { createTool, Tool } from './tool.js'
export type { ToolConfig } from './tool.js'

export { runAgent, MaxStepsError, AgentAbortError, ContextBudgetError } from './agent.js'
export type { AgentConfig, AgentResult } from './agent.js'

export { AgentRunHandle } from './handle.js'
export type { RunState, RunStatus, ActiveToolCall } from './handle.js'

export { SlidingWindowStrategy, defaultTokenCounter } from './strategy.js'
export type { EvictionStrategy, TokenCounter } from './strategy.js'

export { createOpenAIProvider } from './providers/openai.js'
export type { OpenAIProviderOptions } from './providers/openai.js'

export type {
  Message,
  ToolCallRequest,
  ToolParameter,
  ToolSpec,
  GenerateResult,
  StreamCallbacks,
  Provider,
  Usage,
} from './types.js'

