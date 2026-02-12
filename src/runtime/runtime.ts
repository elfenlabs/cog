/**
 * GraphRuntime — executes a GraphDefinition against a ContextChain.
 *
 * The runtime loop:
 * 1. Enter node (push scope, create scratch nodes)
 * 2. Execute node (LLM call, tool call, router, or subgraph)
 * 3. Resolve transition (find next node via edges)
 * 4. Exit node (collapse scratch, pop scope)
 * 5. Repeat until terminal node or maxSteps
 */

import { ContextChain } from '../context/index.js'
import type { ContextNodeHandle, ContextFormatter } from '../context/index.js'
import type { GraphDefinition } from '../graph/definition.js'
import { resolveEdges } from '../graph/definition.js'
import type { AnyNodeConfig, LLMCallNodeConfig, ToolCallNodeConfig, RouterNodeConfig, SubgraphNodeConfig, NodeExecutionContext } from '../graph/nodes.js'
import { ToolRegistry } from '../graph/tool-registry.js'
import type { LLMProvider } from '../types/index.js'
import { SideChannel } from './side-channel.js'
import { GraphControlError } from './errors.js'

// ---------------------------------------------------------------------------
// Runtime Options
// ---------------------------------------------------------------------------

export interface RuntimeOptions {
  llmProvider: LLMProvider
  contextFormatter: ContextFormatter<unknown>
  sideChannel?: SideChannel
  signal?: AbortSignal
  maxSteps?: number
  nodeTimeoutMs?: number | ((nodeId: string) => number)

  onError?: 'throw' | 'transition'
  errorNode?: string

  onNodeEnter?: (nodeId: string) => void
  onNodeExit?: (nodeId: string, result: unknown) => void
  onTransition?: (from: string, to: string, label?: string) => void
}

// ---------------------------------------------------------------------------
// Run Result
// ---------------------------------------------------------------------------

export interface RunResult {
  finalNodeId: string
  sideChannel: SideChannel
  chain: ContextChain
  steps: number
}

// ---------------------------------------------------------------------------
// Serialized State
// ---------------------------------------------------------------------------

export interface SerializedRunState {
  schemaVersion: number
  currentNodeId: string
  steps: number
  lastResult: unknown
}

const SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// GraphRuntime
// ---------------------------------------------------------------------------

export class GraphRuntime {
  private currentNodeId: string = ''
  private steps: number = 0
  private lastResult: unknown = undefined

  /**
   * Execute a graph from start to completion.
   */
  async run(
    graph: GraphDefinition,
    chain: ContextChain,
    options: RuntimeOptions,
  ): Promise<RunResult> {
    const {
      llmProvider,
      contextFormatter,
      signal,
      maxSteps = 100,
      onError = 'throw',
      errorNode,
    } = options

    const sideChannel = options.sideChannel ?? new SideChannel()
    const toolRegistry = new ToolRegistry(graph)

    this.currentNodeId = graph.entryNode
    this.steps = 0
    this.lastResult = undefined

    while (true) {
      // Check abort
      if (signal?.aborted) {
        throw new GraphControlError('Execution aborted', this.currentNodeId)
      }

      // Check max steps
      if (this.steps >= maxSteps) {
        throw new GraphControlError(
          `Maximum steps (${maxSteps}) exceeded`,
          this.currentNodeId,
          { steps: this.steps },
        )
      }

      const node = graph.nodes[this.currentNodeId]
      if (!node) {
        throw new GraphControlError(`Node "${this.currentNodeId}" not found`)
      }

      // Enter node
      options.onNodeEnter?.(this.currentNodeId)
      toolRegistry.enterNode(this.currentNodeId, node)

      // Create scratch nodes
      const scratchHandles: ContextNodeHandle[] = []
      if (node.scratchNodes) {
        for (const scratch of node.scratchNodes) {
          const handle = chain.insert(scratch.content, scratch.pin)
          scratchHandles.push(handle)
        }
      }

      // Create instruction CN for LLM nodes
      let instructionHandle: ContextNodeHandle | undefined
      if (node.type === 'llm') {
        instructionHandle = chain.insert(
          (node as LLMCallNodeConfig).instructions,
          { type: 'tail', priority: 999 },
        )
      }

      // Execute node
      const ctx: NodeExecutionContext = {
        chain,
        sideChannel,
        signal,
      }

      let result: unknown
      try {
        result = await this.executeNode(
          node, ctx, llmProvider, contextFormatter, toolRegistry, sideChannel,
        )
      } catch (err) {
        // Remove scratch and instruction nodes on error
        this.cleanupScratch(chain, scratchHandles, instructionHandle)
        toolRegistry.exitNode()

        if (onError === 'transition' && errorNode && graph.nodes[errorNode]) {
          sideChannel.set('__error' as any, {
            error: err instanceof Error ? err.message : String(err),
            nodeId: this.currentNodeId,
          })
          options.onNodeExit?.(this.currentNodeId, undefined)
          this.currentNodeId = errorNode
          this.steps++
          continue
        }
        throw err
      }

      this.lastResult = result
      this.steps++

      // Collapse scratch nodes
      if (node.scratchNodes) {
        for (let i = 0; i < node.scratchNodes.length; i++) {
          const config = node.scratchNodes[i]
          const handle = scratchHandles[i]
          if (config.collapseOnExit) {
            const currentContent = chain.get(handle)?.content ?? ''
            const collapsed = await config.collapseOnExit(String(currentContent), ctx)
            chain.update(handle, collapsed)
          } else {
            chain.remove(handle)
          }
        }
      }

      // Remove instruction CN
      if (instructionHandle) {
        chain.remove(instructionHandle)
      }

      // Exit node
      toolRegistry.exitNode()
      options.onNodeExit?.(this.currentNodeId, result)

      // Resolve transition
      const nextNodeId = this.resolveTransition(graph, node, result, sideChannel)

      // Terminal check: terminate if this node is terminal AND no transition matched.
      // This allows a node to be both terminal and loopable — it exits when
      // there's nowhere left to go, but keeps running if a transition fires.
      if (!nextNodeId) {
        if (graph.terminalNodes.includes(this.currentNodeId)) {
          return {
            finalNodeId: this.currentNodeId,
            sideChannel,
            chain,
            steps: this.steps,
          }
        }
        throw new GraphControlError(
          `No matching transition from node "${this.currentNodeId}"`,
          this.currentNodeId,
          { result },
        )
      }

      options.onTransition?.(this.currentNodeId, nextNodeId)
      this.currentNodeId = nextNodeId
    }
  }

  /**
   * Execute a single node based on its type.
   */
  private async executeNode(
    node: AnyNodeConfig,
    ctx: NodeExecutionContext,
    llmProvider: LLMProvider,
    contextFormatter: ContextFormatter<unknown>,
    toolRegistry: ToolRegistry,
    sideChannel: SideChannel,
  ): Promise<unknown> {
    switch (node.type) {
      case 'llm': {
        const llmNode = node as LLMCallNodeConfig
        const context = ctx.chain.build(contextFormatter)
        const tools = toolRegistry.getActiveTools()
        const result = await llmProvider.generate({
          context,
          tools: tools.length > 0 ? tools : undefined,
          onChunk: llmNode.onChunk,
        })
        return result
      }

      case 'tool': {
        const toolNode = node as ToolCallNodeConfig
        return toolNode.execute(this.lastResult, ctx)
      }

      case 'router': {
        const routerNode = node as RouterNodeConfig
        const label = routerNode.route(this.lastResult, sideChannel)
        return label
      }

      case 'subgraph': {
        const subNode = node as SubgraphNodeConfig
        let subChain: ContextChain

        if (subNode.scope === 'isolated') {
          subChain = new ContextChain()
          // Optionally inherit specific nodes
          if (subNode.inheritNodes) {
            for (const handle of subNode.inheritNodes) {
              const parentNode = ctx.chain.get(handle)
              if (parentNode) {
                subChain.insert(String(parentNode.content), parentNode.pin, parentNode.metadata)
              }
            }
          }
        } else {
          subChain = ctx.chain
        }

        const subRuntime = new GraphRuntime()
        const subResult = await subRuntime.run(subNode.graph, subChain, {
          llmProvider,
          contextFormatter,
          sideChannel,
          signal: ctx.signal,
        })
        return subResult
      }

      default: {
        const _exhaustive: never = node
        throw new GraphControlError(`Unknown node type: ${(node as AnyNodeConfig).type}`, (node as AnyNodeConfig).id)
      }
    }
  }

  /**
   * Find the next node based on transitions.
   */
  private resolveTransition(
    graph: GraphDefinition,
    node: AnyNodeConfig,
    result: unknown,
    sideChannel: SideChannel,
  ): string | undefined {
    if (!node.next || node.next.length === 0) return undefined

    // For router nodes, the result is the label
    if (node.type === 'router') {
      const label = result as string
      const match = node.next.find(t => t.on === label)
      return match?.to
    }

    // For other nodes, evaluate guards and labels
    for (const transition of node.next) {
      // If transition has a `when` guard, evaluate it
      if (transition.when) {
        if (transition.when(result, sideChannel)) {
          return transition.to
        }
        continue
      }

      // If no guard and no label, it's a default transition
      if (!transition.on) {
        return transition.to
      }
    }

    return undefined
  }

  /**
   * Remove scratch and instruction nodes on error.
   */
  private cleanupScratch(
    chain: ContextChain,
    scratchHandles: ContextNodeHandle[],
    instructionHandle?: ContextNodeHandle,
  ): void {
    for (const handle of scratchHandles) {
      try { chain.remove(handle) } catch { /* already removed */ }
    }
    if (instructionHandle) {
      try { chain.remove(instructionHandle) } catch { /* already removed */ }
    }
  }

  /**
   * Serialize current execution state for pause/resume.
   */
  pause(): SerializedRunState {
    return {
      schemaVersion: SCHEMA_VERSION,
      currentNodeId: this.currentNodeId,
      steps: this.steps,
      lastResult: this.lastResult,
    }
  }

  /**
   * Resume execution from a serialized state.
   */
  static fromState(state: SerializedRunState): GraphRuntime {
    if (state.schemaVersion !== SCHEMA_VERSION) {
      throw new GraphControlError(`Unsupported runtime state schema version: ${state.schemaVersion}`)
    }
    const runtime = new GraphRuntime()
    runtime.currentNodeId = state.currentNodeId
    runtime.steps = state.steps
    runtime.lastResult = state.lastResult
    return runtime
  }
}
