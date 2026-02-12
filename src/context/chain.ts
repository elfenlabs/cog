/**
 * ContextChain — ordered collection of context nodes.
 * Supports pinning rules, in-place mutation, and pluggable build formatters.
 */

import type { ContextNode, ContextNodeHandle, PinRule } from './node.js'
import { createNode, DEFAULT_PIN } from './node.js'

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

export type ContextFormatter<T> = (nodes: ReadonlyArray<ContextNode>) => T

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export interface SerializedChain {
  schemaVersion: number
  nodes: SerializedNode[]
}

export interface SerializedNode {
  handleId: string
  content: string
  pin: PinRule
  metadata?: Record<string, unknown>
}

const SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

export class PinCycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Pinning cycle detected: ${cycle.join(' → ')}`)
    this.name = 'PinCycleError'
  }
}

/**
 * Resolve the ordering of context nodes based on their pin rules.
 *
 * Algorithm:
 * 1. Partition into head / floating / tail groups
 * 2. Within each group, topological sort on before/after edges (with cycle detection)
 * 3. Stable secondary sort by priority, then insertion order
 * 4. Missing ref → treat as floating (no error)
 */
function resolveOrder(nodes: ContextNode[]): ContextNode[] {
  const heads: ContextNode[] = []
  const floating: ContextNode[] = []
  const tails: ContextNode[] = []
  const handleToNode = new Map<string, ContextNode>()
  const handleToIndex = new Map<string, number>()

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    handleToNode.set(node.handle.id, node)
    handleToIndex.set(node.handle.id, i)
  }

  // Collect before/after edges
  const mustComeBefore = new Map<string, Set<string>>() // A must come before B
  const mustComeAfter = new Map<string, Set<string>>()  // A must come after B

  for (const node of nodes) {
    const pin = node.pin
    if (pin.type === 'head') {
      heads.push(node)
    } else if (pin.type === 'tail') {
      tails.push(node)
    } else if (pin.type === 'before') {
      if (handleToNode.has(pin.ref.id)) {
        // This node must come before pin.ref
        if (!mustComeBefore.has(node.handle.id)) mustComeBefore.set(node.handle.id, new Set())
        mustComeBefore.get(node.handle.id)!.add(pin.ref.id)
        if (!mustComeAfter.has(pin.ref.id)) mustComeAfter.set(pin.ref.id, new Set())
        mustComeAfter.get(pin.ref.id)!.add(node.handle.id)
        floating.push(node)
      } else {
        // Missing ref → treat as floating
        floating.push(node)
      }
    } else if (pin.type === 'after') {
      if (handleToNode.has(pin.ref.id)) {
        // This node must come after pin.ref
        if (!mustComeAfter.has(node.handle.id)) mustComeAfter.set(node.handle.id, new Set())
        mustComeAfter.get(node.handle.id)!.add(pin.ref.id)
        if (!mustComeBefore.has(pin.ref.id)) mustComeBefore.set(pin.ref.id, new Set())
        mustComeBefore.get(pin.ref.id)!.add(node.handle.id)
        floating.push(node)
      } else {
        floating.push(node)
      }
    } else {
      floating.push(node)
    }
  }

  // Sort heads and tails by priority (lower = earlier), then insertion order
  const sortByPriority = (a: ContextNode, b: ContextNode): number => {
    const ap = (a.pin as { priority?: number }).priority ?? 0
    const bp = (b.pin as { priority?: number }).priority ?? 0
    if (ap !== bp) return ap - bp
    return (handleToIndex.get(a.handle.id) ?? 0) - (handleToIndex.get(b.handle.id) ?? 0)
  }

  heads.sort(sortByPriority)
  tails.sort(sortByPriority)

  // Topological sort floating nodes with cycle detection
  const sorted = topoSort(floating, mustComeAfter, handleToIndex)

  return [...heads, ...sorted, ...tails]
}

/**
 * Topological sort using Kahn's algorithm with cycle detection.
 * `dependencies` maps nodeId → set of nodeIds that must come before it.
 */
function topoSort(
  nodes: ContextNode[],
  dependencies: Map<string, Set<string>>,
  insertionOrder: Map<string, number>,
): ContextNode[] {
  const nodeIds = new Set(nodes.map(n => n.handle.id))
  const nodeMap = new Map(nodes.map(n => [n.handle.id, n]))

  // Build adjacency: who depends on whom (within the floating set)
  const inDegree = new Map<string, number>()
  const adjList = new Map<string, string[]>()

  for (const id of nodeIds) {
    inDegree.set(id, 0)
    adjList.set(id, [])
  }

  for (const id of nodeIds) {
    const deps = dependencies.get(id)
    if (!deps) continue
    for (const depId of deps) {
      if (!nodeIds.has(depId)) continue // dep is in a different partition
      // depId must come before id → edge depId → id
      adjList.get(depId)!.push(id)
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1)
    }
  }

  // Kahn's algorithm
  // Use a sorted queue for deterministic output (by insertion order)
  const queue: string[] = []
  for (const id of nodeIds) {
    if (inDegree.get(id) === 0) {
      queue.push(id)
    }
  }
  queue.sort((a, b) => (insertionOrder.get(a) ?? 0) - (insertionOrder.get(b) ?? 0))

  const result: ContextNode[] = []

  while (queue.length > 0) {
    const id = queue.shift()!
    result.push(nodeMap.get(id)!)

    const neighbors = adjList.get(id) ?? []
    const readyNeighbors: string[] = []
    for (const neighbor of neighbors) {
      const deg = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, deg)
      if (deg === 0) {
        readyNeighbors.push(neighbor)
      }
    }
    // Sort newly ready neighbors by insertion order for determinism
    readyNeighbors.sort((a, b) => (insertionOrder.get(a) ?? 0) - (insertionOrder.get(b) ?? 0))
    queue.push(...readyNeighbors)
  }

  if (result.length !== nodes.length) {
    // Cycle detected — find the cycle
    const remaining = nodes.filter(n => !result.includes(n)).map(n => n.handle.id)
    throw new PinCycleError(remaining)
  }

  return result
}

// ---------------------------------------------------------------------------
// ContextChain
// ---------------------------------------------------------------------------

export class ContextChain {
  private nodes: Map<string, ContextNode> = new Map()
  private insertionOrder: string[] = []

  /** Insert a new context node. Returns its handle. */
  insert(content: string, pin: PinRule = DEFAULT_PIN, metadata?: Record<string, unknown>): ContextNodeHandle {
    const node = createNode(content, pin, metadata)
    this.nodes.set(node.handle.id, node)
    this.insertionOrder.push(node.handle.id)
    return node.handle
  }

  /** Update the content of an existing node. */
  update(handle: ContextNodeHandle, content: string): void {
    const node = this.nodes.get(handle.id)
    if (!node) throw new Error(`ContextNode not found: ${handle.id}`)
    node.content = content
  }

  /** Remove a node from the chain. */
  remove(handle: ContextNodeHandle): void {
    if (!this.nodes.delete(handle.id)) {
      throw new Error(`ContextNode not found: ${handle.id}`)
    }
    this.insertionOrder = this.insertionOrder.filter(id => id !== handle.id)
  }

  /** Get a node by handle. */
  get(handle: ContextNodeHandle): ContextNode | undefined {
    return this.nodes.get(handle.id)
  }

  /** Get all nodes in resolved order. */
  getAll(): ReadonlyArray<ContextNode> {
    const all = this.insertionOrder
      .map(id => this.nodes.get(id))
      .filter((n): n is ContextNode => n !== undefined)
    return resolveOrder(all)
  }

  /** Get only floating nodes (for compaction strategies). */
  getFloating(): ReadonlyArray<ContextNode> {
    return this.getAll().filter(n => n.pin.type === 'floating')
  }

  /** Get the number of nodes. */
  get size(): number {
    return this.nodes.size
  }

  /** Build the chain into any format using a user-provided formatter. */
  build<T>(formatter: ContextFormatter<T>): T {
    return formatter(this.getAll())
  }

  /** Serialize the chain for persistence. */
  serialize(): SerializedChain {
    const ordered = this.getAll()
    return {
      schemaVersion: SCHEMA_VERSION,
      nodes: ordered.map(n => ({
        handleId: n.handle.id,
        content: String(n.content),
        pin: n.pin,
        metadata: n.metadata,
      })),
    }
  }

  /** Deserialize a chain from persisted data. */
  static deserialize(data: SerializedChain): ContextChain {
    if (data.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`Unsupported schema version: ${data.schemaVersion} (expected ${SCHEMA_VERSION})`)
    }
    const chain = new ContextChain()
    for (const sn of data.nodes) {
      const handle = { __brand: 'ContextNodeHandle' as const, id: sn.handleId }
      const node: ContextNode = {
        handle,
        content: sn.content,
        pin: sn.pin,
        metadata: sn.metadata,
      }
      chain.nodes.set(handle.id, node)
      chain.insertionOrder.push(handle.id)
    }
    return chain
  }
}
