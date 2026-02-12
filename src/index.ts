/**
 * Cog — Agent SDK
 *
 * An unopinionated agent framework for TypeScript.
 * Context chain + control flow graph.
 */

// Context Layer
export { ContextChain, PinCycleError, resetHandleCounter } from './context/index.js'
export type {
  ContextFormatter,
  ContextNode,
  ContextNodeHandle,
  PinRule,
  SerializedChain,
  SerializedNode,
} from './context/index.js'

// Graph Layer
export { defineGraph, resolveEdges, ToolRegistry, visualize } from './graph/index.js'
export type {
  ActionNodeConfig,
  AnyNodeConfig,
  GraphDefinition,
  LLMCallNodeConfig,
  NodeExecutionContext,
  ResolvedEdge,
  RouterNodeConfig,
  ScratchNodeConfig,
  SubgraphNodeConfig,
  ToolCallNodeConfig,
  TransitionDefinition,
  VisualizationFormat,
} from './graph/index.js'

// Runtime Layer
export { GraphRuntime, SideChannel, key, GraphControlError, SerializationError } from './runtime/index.js'
export type {
  RuntimeOptions,
  RunResult,
  SerializedRunState,
  SideChannelKey,
  SerializedSideChannel,
} from './runtime/index.js'

// Types
export type { LLMProvider, LLMRequest, LLMResult, ToolCall, ToolDefinition, ParameterDef } from './types/index.js'
