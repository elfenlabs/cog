/**
 * ToolRegistry — resolves the active tool set based on scope inheritance.
 *
 * Tools inherit down the graph tree:
 * - Graph-level tools are available to all nodes
 * - Subgraph-level tools are available to the owning node and descendants
 * - Node-level tools are available only during the owning node's execution
 *
 * Name collisions: child overrides parent.
 */

import type { ToolDefinition } from '../types/index.js'
import type { AnyNodeConfig } from './nodes.js'
import type { GraphDefinition } from './definition.js'

export class ToolRegistry {
  private scopes: Map<string, ToolDefinition[]>[] = []
  private graphTools: ToolDefinition[]

  constructor(graph: GraphDefinition) {
    this.graphTools = graph.tools ?? []
    // Push graph-level tools as the root scope
    const rootScope = new Map<string, ToolDefinition[]>()
    rootScope.set('__graph__', this.graphTools)
    this.scopes.push(rootScope)
  }

  /** Push a new scope when entering a node */
  enterNode(nodeId: string, node: AnyNodeConfig): void {
    const tools = node.tools ?? []
    const scope = new Map<string, ToolDefinition[]>()
    scope.set(nodeId, tools)
    this.scopes.push(scope)
  }

  /** Pop the scope when exiting a node */
  exitNode(): void {
    if (this.scopes.length > 1) {
      this.scopes.pop()
    }
  }

  /** Get all currently active tools, with child overriding parent by name */
  getActiveTools(): ToolDefinition[] {
    const toolMap = new Map<string, ToolDefinition>()

    // Apply from root to leaf — later scopes override earlier
    for (const scope of this.scopes) {
      for (const tools of scope.values()) {
        for (const tool of tools) {
          toolMap.set(tool.name, tool)
        }
      }
    }

    return [...toolMap.values()]
  }

  /** Find a specific tool by name in the active set */
  findTool(name: string): ToolDefinition | undefined {
    // Search from leaf to root for efficiency
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      for (const tools of this.scopes[i].values()) {
        for (const tool of tools) {
          if (tool.name === name) return tool
        }
      }
    }
    return undefined
  }
}
