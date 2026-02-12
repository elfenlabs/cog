import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  defineGraph,
  visualize,
  ToolRegistry,
} from './graph/index.js'
import type { AnyNodeConfig, LLMCallNodeConfig, RouterNodeConfig, ToolCallNodeConfig } from './graph/index.js'
import type { ToolDefinition } from './types/index.js'

// ===========================================================================
// Graph Layer Tests
// ===========================================================================

describe('defineGraph', () => {
  const sampleGraph = () => defineGraph({
    nodes: {
      start: {
        type: 'llm', id: 'start',
        instructions: 'hello',
        next: [{ to: 'route' }],
      } satisfies LLMCallNodeConfig,
      route: {
        type: 'router', id: 'route',
        route: () => 'done',
        next: [
          { to: 'end', on: 'done' },
        ],
      } satisfies RouterNodeConfig,
      end: {
        type: 'llm', id: 'end',
        instructions: 'bye',
      } satisfies LLMCallNodeConfig,
    },
    entryNode: 'start',
    terminalNodes: ['end'],
  })

  it('should create a valid graph', () => {
    const graph = sampleGraph()
    assert.equal(graph.entryNode, 'start')
    assert.deepEqual(graph.terminalNodes, ['end'])
    assert.ok(graph.nodes.start)
    assert.ok(graph.nodes.route)
    assert.ok(graph.nodes.end)
  })

  it('should throw on missing entry node', () => {
    assert.throws(
      () => defineGraph({
        nodes: { a: { type: 'llm', id: 'a', instructions: 'x' } satisfies LLMCallNodeConfig },
        entryNode: 'missing',
        terminalNodes: ['a'],
      }),
      /Entry node "missing" not found/,
    )
  })

  it('should throw on missing terminal node', () => {
    assert.throws(
      () => defineGraph({
        nodes: { a: { type: 'llm', id: 'a', instructions: 'x' } satisfies LLMCallNodeConfig },
        entryNode: 'a',
        terminalNodes: ['missing'],
      }),
      /Terminal node "missing" not found/,
    )
  })

  it('should throw on transition to unknown node', () => {
    assert.throws(
      () => defineGraph({
        nodes: {
          a: {
            type: 'llm', id: 'a', instructions: 'x',
            next: [{ to: 'missing' }],
          } satisfies LLMCallNodeConfig,
        },
        entryNode: 'a',
        terminalNodes: ['a'],
      }),
      /transition to unknown node "missing"/,
    )
  })
})

describe('visualize', () => {
  const graph = defineGraph({
    nodes: {
      analyze: {
        type: 'llm', id: 'analyze',
        instructions: 'Analyze',
        next: [{ to: 'route' }],
      } satisfies LLMCallNodeConfig,
      route: {
        type: 'router', id: 'route',
        route: () => 'done',
        next: [
          { to: 'tool', on: 'tool' },
          { to: 'done', on: 'done' },
        ],
      } satisfies RouterNodeConfig,
      tool: {
        type: 'tool', id: 'tool',
        execute: async () => ({}),
        next: [{ to: 'analyze' }],
      } satisfies ToolCallNodeConfig,
      done: {
        type: 'llm', id: 'done',
        instructions: 'Done',
      } satisfies LLMCallNodeConfig,
    },
    entryNode: 'analyze',
    terminalNodes: ['done'],
  })

  it('should generate mermaid output', () => {
    const mermaid = visualize(graph, 'mermaid')
    assert.ok(mermaid.includes('graph TD'))
    assert.ok(mermaid.includes('analyze'))
    assert.ok(mermaid.includes('route'))
    assert.ok(mermaid.includes('|tool|'))
    assert.ok(mermaid.includes('|done|'))
  })

  it('should generate ascii output', () => {
    const ascii = visualize(graph, 'ascii')
    assert.ok(ascii.includes('Control Flow Graph'))
    assert.ok(ascii.includes('[ENTRY]'))
    assert.ok(ascii.includes('[TERMINAL]'))
    assert.ok(ascii.includes('analyze'))
  })
})

describe('ToolRegistry', () => {
  const makeTool = (name: string): ToolDefinition => ({
    name,
    description: `Tool ${name}`,
    parameters: {},
    execute: async () => ({}),
  })

  it('should inherit graph-level tools', () => {
    const tool = makeTool('globalTool')
    const graph = defineGraph({
      tools: [tool],
      nodes: {
        a: { type: 'llm', id: 'a', instructions: 'x' } satisfies LLMCallNodeConfig,
      },
      entryNode: 'a',
      terminalNodes: ['a'],
    })

    const registry = new ToolRegistry(graph)
    const tools = registry.getActiveTools()
    assert.equal(tools.length, 1)
    assert.equal(tools[0].name, 'globalTool')
  })

  it('should scope tools to nodes', () => {
    const graph = defineGraph({
      nodes: {
        a: { type: 'llm', id: 'a', instructions: 'x' } satisfies LLMCallNodeConfig,
      },
      entryNode: 'a',
      terminalNodes: ['a'],
    })

    const registry = new ToolRegistry(graph)
    const nodeTool = makeTool('nodeTool')

    // Before entering node
    assert.equal(registry.getActiveTools().length, 0)

    // Enter node with tool
    registry.enterNode('a', { ...graph.nodes['a'], tools: [nodeTool] })
    assert.equal(registry.getActiveTools().length, 1)
    assert.equal(registry.getActiveTools()[0].name, 'nodeTool')

    // Exit node
    registry.exitNode()
    assert.equal(registry.getActiveTools().length, 0)
  })

  it('should override parent tools by name', () => {
    const parentTool: ToolDefinition = {
      ...makeTool('sharedTool'),
      description: 'parent version',
    }
    const childTool: ToolDefinition = {
      ...makeTool('sharedTool'),
      description: 'child version',
    }

    const graph = defineGraph({
      tools: [parentTool],
      nodes: {
        a: { type: 'llm', id: 'a', instructions: 'x' } satisfies LLMCallNodeConfig,
      },
      entryNode: 'a',
      terminalNodes: ['a'],
    })

    const registry = new ToolRegistry(graph)
    registry.enterNode('a', { ...graph.nodes['a'], tools: [childTool] })

    const active = registry.getActiveTools()
    assert.equal(active.length, 1)
    assert.equal(active[0].description, 'child version')
  })

  it('should find tool by name', () => {
    const tool = makeTool('findMe')
    const graph = defineGraph({
      tools: [tool],
      nodes: {
        a: { type: 'llm', id: 'a', instructions: 'x' } satisfies LLMCallNodeConfig,
      },
      entryNode: 'a',
      terminalNodes: ['a'],
    })

    const registry = new ToolRegistry(graph)
    assert.ok(registry.findTool('findMe'))
    assert.equal(registry.findTool('notHere'), undefined)
  })
})
