/**
 * Graph Visualizer — renders a GraphDefinition for inspection.
 *
 * Supported formats:
 * - 'mermaid': Mermaid diagram syntax (paste into docs, GitHub, etc.)
 * - 'ascii': Simple ASCII representation for terminal
 */

import type { GraphDefinition } from './definition.js'
import { resolveEdges } from './definition.js'
import type { AnyNodeConfig } from './nodes.js'

// ---------------------------------------------------------------------------
// Node type icons
// ---------------------------------------------------------------------------

const NODE_ICONS: Record<string, string> = {
  llm: '🤖',
  tool: '🔧',
  router: '🔀',
  subgraph: '📦',
}

function getIcon(node: AnyNodeConfig): string {
  return NODE_ICONS[node.type] ?? '⬜'
}

// ---------------------------------------------------------------------------
// Mermaid format
// ---------------------------------------------------------------------------

function toMermaid(graph: GraphDefinition): string {
  const lines: string[] = ['graph TD']
  const edges = resolveEdges(graph)

  // Declare nodes
  for (const [id, node] of Object.entries(graph.nodes)) {
    const icon = getIcon(node)
    const isTerminal = graph.terminalNodes.includes(id)
    const isEntry = graph.entryNode === id

    let label = `${icon} ${id}`
    if (isEntry) label += ' ▶'
    if (isTerminal) label += ' ■'

    lines.push(`  ${id}["${label}"]`)
  }

  // Declare edges
  for (const edge of edges) {
    if (edge.on) {
      lines.push(`  ${edge.from} -->|${edge.on}| ${edge.to}`)
    } else {
      lines.push(`  ${edge.from} --> ${edge.to}`)
    }
  }

  // Style entry and terminal nodes
  lines.push('')
  lines.push(`  style ${graph.entryNode} stroke:#4CAF50,stroke-width:3px`)
  for (const terminal of graph.terminalNodes) {
    lines.push(`  style ${terminal} stroke:#F44336,stroke-width:3px`)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// ASCII format
// ---------------------------------------------------------------------------

function toAscii(graph: GraphDefinition): string {
  const lines: string[] = []
  const edges = resolveEdges(graph)

  lines.push('┌─────────────────────────────────────┐')
  lines.push('│          Control Flow Graph          │')
  lines.push('├─────────────────────────────────────┤')

  // List nodes
  for (const [id, node] of Object.entries(graph.nodes)) {
    const icon = getIcon(node)
    const isTerminal = graph.terminalNodes.includes(id)
    const isEntry = graph.entryNode === id

    let markers = ''
    if (isEntry) markers += ' [ENTRY]'
    if (isTerminal) markers += ' [TERMINAL]'

    lines.push(`│  ${icon} ${id}${markers}`)

    // Show outgoing edges
    const outEdges = edges.filter(e => e.from === id)
    for (let i = 0; i < outEdges.length; i++) {
      const edge = outEdges[i]
      const isLast = i === outEdges.length - 1
      const prefix = isLast ? '└' : '├'
      const label = edge.on ? ` [${edge.on}]` : ''
      lines.push(`│    ${prefix}→ ${edge.to}${label}`)
    }
  }

  lines.push('└─────────────────────────────────────┘')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type VisualizationFormat = 'mermaid' | 'ascii'

export function visualize(graph: GraphDefinition, format: VisualizationFormat = 'mermaid'): string {
  switch (format) {
    case 'mermaid':
      return toMermaid(graph)
    case 'ascii':
      return toAscii(graph)
    default:
      throw new Error(`Unknown visualization format: ${format}`)
  }
}
