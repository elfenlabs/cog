import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  ContextChain,
  PinCycleError,
  resetHandleCounter,
} from './context/index.js'
import type { ContextNodeHandle, PinRule } from './context/index.js'

// Reset counter before each test for deterministic handles
beforeEach(() => resetHandleCounter())

// ===========================================================================
// Context Layer Tests
// ===========================================================================

describe('ContextChain', () => {
  it('should insert and retrieve nodes', () => {
    const chain = new ContextChain()
    const h1 = chain.insert('Hello')
    const h2 = chain.insert('World')

    assert.equal(chain.size, 2)
    assert.equal(chain.get(h1)?.content, 'Hello')
    assert.equal(chain.get(h2)?.content, 'World')
  })

  it('should update node content in place', () => {
    const chain = new ContextChain()
    const h = chain.insert('original')
    chain.update(h, 'updated')
    assert.equal(chain.get(h)?.content, 'updated')
  })

  it('should remove nodes', () => {
    const chain = new ContextChain()
    const h = chain.insert('temp')
    assert.equal(chain.size, 1)
    chain.remove(h)
    assert.equal(chain.size, 0)
    assert.equal(chain.get(h), undefined)
  })

  it('should throw on update/remove of missing node', () => {
    const chain = new ContextChain()
    const fakeHandle = { __brand: 'ContextNodeHandle' as const, id: 'fake' }
    assert.throws(() => chain.update(fakeHandle, 'x'), /not found/)
    assert.throws(() => chain.remove(fakeHandle), /not found/)
  })

  it('should order head nodes before floating before tail', () => {
    const chain = new ContextChain()
    chain.insert('floating1')
    chain.insert('tail1', { type: 'tail' })
    chain.insert('head1', { type: 'head' })
    chain.insert('floating2')

    const ordered = chain.getAll().map(n => n.content)
    assert.deepEqual(ordered, ['head1', 'floating1', 'floating2', 'tail1'])
  })

  it('should sort head/tail by priority', () => {
    const chain = new ContextChain()
    chain.insert('head-low', { type: 'head', priority: 10 })
    chain.insert('head-high', { type: 'head', priority: 1 })
    chain.insert('tail-low', { type: 'tail', priority: 10 })
    chain.insert('tail-high', { type: 'tail', priority: 1 })

    const ordered = chain.getAll().map(n => n.content)
    assert.deepEqual(ordered, ['head-high', 'head-low', 'tail-high', 'tail-low'])
  })

  it('should handle before/after pin rules', () => {
    const chain = new ContextChain()
    const h1 = chain.insert('first')
    const h2 = chain.insert('second')
    chain.insert('before-second', { type: 'before', ref: h2 })
    chain.insert('after-first', { type: 'after', ref: h1 })

    const ordered = chain.getAll().map(n => n.content)
    // first should come before after-first, before-second should come before second
    const firstIdx = ordered.indexOf('first')
    const afterFirstIdx = ordered.indexOf('after-first')
    const beforeSecondIdx = ordered.indexOf('before-second')
    const secondIdx = ordered.indexOf('second')

    assert.ok(firstIdx < afterFirstIdx, 'first should be before after-first')
    assert.ok(beforeSecondIdx < secondIdx, 'before-second should be before second')
  })

  it('should treat missing ref as floating', () => {
    const chain = new ContextChain()
    const fakeHandle = { __brand: 'ContextNodeHandle' as const, id: 'nonexistent' }
    chain.insert('head', { type: 'head' })
    chain.insert('orphan-before', { type: 'before', ref: fakeHandle })
    chain.insert('tail', { type: 'tail' })

    const ordered = chain.getAll().map(n => n.content)
    // orphan should be treated as floating (between head and tail)
    assert.equal(ordered[0], 'head')
    assert.equal(ordered[ordered.length - 1], 'tail')
    assert.ok(ordered.includes('orphan-before'))
  })

  it('should only return floating nodes from getFloating()', () => {
    const chain = new ContextChain()
    chain.insert('head', { type: 'head' })
    chain.insert('float1')
    chain.insert('float2')
    chain.insert('tail', { type: 'tail' })

    const floating = chain.getFloating().map(n => n.content)
    assert.deepEqual(floating, ['float1', 'float2'])
  })

  it('should build with a custom formatter', () => {
    const chain = new ContextChain()
    chain.insert('Hello')
    chain.insert('World')

    const result = chain.build(nodes => nodes.map(n => n.content).join(' '))
    assert.equal(result, 'Hello World')
  })

  it('should build into structured format', () => {
    const chain = new ContextChain()
    chain.insert('system prompt', { type: 'head' })
    chain.insert('user message')

    type Message = { role: string; content: string }
    const messages = chain.build<Message[]>(nodes =>
      nodes.map((n, i) => ({
        role: i === 0 ? 'system' : 'user',
        content: String(n.content),
      }))
    )

    assert.equal(messages.length, 2)
    assert.equal(messages[0].role, 'system')
    assert.equal(messages[1].role, 'user')
  })

  it('should serialize and deserialize', () => {
    const chain = new ContextChain()
    chain.insert('head', { type: 'head' })
    chain.insert('body')
    chain.insert('tail', { type: 'tail' })

    const serialized = chain.serialize()
    assert.equal(serialized.schemaVersion, 1)
    assert.equal(serialized.nodes.length, 3)

    const restored = ContextChain.deserialize(serialized)
    assert.equal(restored.size, 3)

    const original = chain.getAll().map(n => n.content)
    const restoredOrder = restored.getAll().map(n => n.content)
    assert.deepEqual(restoredOrder, original)
  })

  it('should throw on incompatible schema version', () => {
    assert.throws(
      () => ContextChain.deserialize({ schemaVersion: 999, nodes: [] }),
      /Unsupported schema version/,
    )
  })
})
