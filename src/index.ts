/**
 * Cog v2 — A minimal agent SDK for TypeScript
 *
 * Three primitives, infinite composition.
 */

export { createContext, Context } from './context.js'
export type { ContextOptions, SerializedContext } from './context.js'

export { createTool, Tool } from './tool.js'
export type { ToolConfig } from './tool.js'

export { runAgent, MaxStepsError, AgentAbortError } from './agent.js'
export type { AgentConfig, AgentResult } from './agent.js'

export type {
  Message,
  ToolCallRequest,
  ToolParameter,
  ToolSpec,
  GenerateResult,
  StreamCallbacks,
  Provider,
} from './types.js'
