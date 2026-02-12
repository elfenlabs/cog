/**
 * GraphDefinition — declarative state machine definition.
 * defineGraph() collects node transitions and validates the graph structure.
 */

import type { AnyNodeConfig } from './nodes.js'
import type { ToolDefinition } from '../types/index.js'

// ---------------------------------------------------------------------------
// Graph Definition
// ---------------------------------------------------------------------------

export interface GraphDefinition {
  tools?: ToolDefinition[]
  nodes: Record<string, AnyNodeConfig>
  entryNode: string
  terminalNodes: string[]
}

// ---------------------------------------------------------------------------
// Internal Edge (flattened from node.next)
// ---------------------------------------------------------------------------

export interface ResolvedEdge {
  from: string
  to: string
  on?: string
  when?: (output: unknown, side: unknown) => boolean
  map?: (output: unknown) => unknown
}

// ---------------------------------------------------------------------------
// defineGraph
// ---------------------------------------------------------------------------

export function defineGraph(definition: {
  tools?: ToolDefinition[]
  nodes: Record<string, AnyNodeConfig>
  entryNode: string
  terminalNodes: string[]
}): GraphDefinition {
  const { nodes, entryNode, terminalNodes } = definition

  // Validate entry node exists
  if (!nodes[entryNode]) {
    throw new Error(`Entry node "${entryNode}" not found in nodes`)
  }

  // Validate terminal nodes exist
  for (const terminal of terminalNodes) {
    if (!nodes[terminal]) {
      throw new Error(`Terminal node "${terminal}" not found in nodes`)
    }
  }

  // Validate all transition targets exist
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (node.next) {
      for (const transition of node.next) {
        if (!nodes[transition.to]) {
          throw new Error(`Node "${nodeId}" has transition to unknown node "${transition.to}"`)
        }
      }
    }
  }

  // Validate non-terminal nodes have transitions (warning-level, not error)
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (!terminalNodes.includes(nodeId) && (!node.next || node.next.length === 0)) {
      // This is valid but potentially a mistake — a node with no transitions
      // that isn't a terminal is a dead end
      console.warn(`Warning: Node "${nodeId}" has no transitions and is not a terminal node`)
    }
  }

  return definition
}

// ---------------------------------------------------------------------------
// Edge resolution
// ---------------------------------------------------------------------------

/** Collect all edges from node `next` fields into a flat array */
export function resolveEdges(graph: GraphDefinition): ResolvedEdge[] {
  const edges: ResolvedEdge[] = []
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    if (node.next) {
      for (const transition of node.next) {
        edges.push({
          from: nodeId,
          to: transition.to,
          on: transition.on,
          when: transition.when as ResolvedEdge['when'],
          map: transition.map as ResolvedEdge['map'],
        })
      }
    }
  }
  return edges
}
