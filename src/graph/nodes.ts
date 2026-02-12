/**
 * Action Node types — the building blocks of the control flow graph.
 */

import type { ContextNodeHandle, PinRule } from '../context/index.js'
import type { ToolDefinition } from '../types/index.js'
import type { SideChannel } from '../runtime/side-channel.js'
import type { TransitionDefinition } from './transition.js'

// ---------------------------------------------------------------------------
// Execution Context (passed to node handlers)
// ---------------------------------------------------------------------------

export interface NodeExecutionContext {
  readonly chain: import('../context/index.js').ContextChain
  readonly sideChannel: SideChannel
  readonly signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Scratch Nodes
// ---------------------------------------------------------------------------

export interface ScratchNodeConfig {
  content: string
  pin?: PinRule
  collapseOnExit?: (content: string, ctx: NodeExecutionContext) => string | Promise<string>
}

// ---------------------------------------------------------------------------
// Base ActionNode
// ---------------------------------------------------------------------------

export interface ActionNodeConfig {
  id: string
  tools?: ToolDefinition[]
  toolScope?: 'node' | 'subgraph'
  scratchNodes?: ScratchNodeConfig[]
  next?: TransitionDefinition[]
}

// ---------------------------------------------------------------------------
// Node Type Configs
// ---------------------------------------------------------------------------

export interface LLMCallNodeConfig extends ActionNodeConfig {
  type: 'llm'
  instructions: string
  onChunk?: (chunk: string) => void
}

export interface ToolCallNodeConfig extends ActionNodeConfig {
  type: 'tool'
  execute: (input: unknown, ctx: NodeExecutionContext) => Promise<unknown>
}

export interface RouterNodeConfig extends ActionNodeConfig {
  type: 'router'
  route: (result: unknown, sideChannel: SideChannel) => string
}

export interface SubgraphNodeConfig extends ActionNodeConfig {
  type: 'subgraph'
  graph: import('./definition.js').GraphDefinition
  scope: 'isolated' | 'inherited'
  inheritNodes?: ContextNodeHandle[]
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

export type AnyNodeConfig =
  | LLMCallNodeConfig
  | ToolCallNodeConfig
  | RouterNodeConfig
  | SubgraphNodeConfig
