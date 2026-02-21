import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createContext } from './context.js'
import { SlidingWindowStrategy, defaultTokenCounter } from './strategy.js'

// ── Context: pin / unpin / evict ────────────────────────────────────────────

describe('Context pinning', () => {
  it('pin(-1) sets pinned flag on last pushed message', () => {
    const ctx = createContext()
    ctx.push('A')
    ctx.push('B')
    ctx.pin(-1)
    assert.equal(ctx.messages[1]!.pinned, true)
    assert.equal(ctx.messages[0]!.pinned, undefined)
  })

  it('pin(0) pins the first message', () => {
    const ctx = createContext()
    ctx.push('A')
    ctx.push('B')
    ctx.pin(0)
    assert.equal(ctx.messages[0]!.pinned, true)
  })

  it('unpin() removes the pin flag', () => {
    const ctx = createContext()
    ctx.push('A')
    ctx.pin(0)
    assert.equal(ctx.messages[0]!.pinned, true)
    ctx.unpin(0)
    assert.equal(ctx.messages[0]!.pinned, undefined)
  })

  it('pin() throws on out-of-range index', () => {
    const ctx = createContext()
    ctx.push('A')
    assert.throws(() => ctx.pin(5), RangeError)
    assert.throws(() => ctx.pin(-3), RangeError)
  })
})

describe('Context eviction', () => {
  it('evict() removes messages by flattened index', () => {
    const ctx = createContext()
    ctx.push('A')
    ctx.push('B')
    ctx.push('C')
    ctx.evict([1]) // remove B
    assert.equal(ctx.messages.length, 2)
    assert.equal(ctx.messages[0]!.content, 'A')
    assert.equal(ctx.messages[1]!.content, 'C')
  })

  it('evict() removes multiple indices', () => {
    const ctx = createContext()
    ctx.push('A')
    ctx.push('B')
    ctx.push('C')
    ctx.push('D')
    ctx.evict([0, 2]) // remove A and C
    assert.equal(ctx.messages.length, 2)
    assert.equal(ctx.messages[0]!.content, 'B')
    assert.equal(ctx.messages[1]!.content, 'D')
  })

  it('evict() on forked context only removes owned messages', () => {
    const parent = createContext()
    parent.push('A')
    parent.push('B')

    const child = parent.fork()
    child.push('C')
    child.push('D')

    // Index 2 and 3 in flattened view = child's own messages
    child.evict([2]) // remove C
    assert.equal(child.messages.length, 3) // A, B, D
    assert.equal(child.messages[2]!.content, 'D')
    // Parent is untouched
    assert.equal(parent.messages.length, 2)
  })

  it('evict() throws if targeting parent messages', () => {
    const parent = createContext()
    parent.push('A')
    parent.push('B')

    const child = parent.fork()
    child.push('C')

    assert.throws(() => child.evict([0]), RangeError)
    assert.throws(() => child.evict([1]), RangeError)
  })

  it('evict([]) is a no-op', () => {
    const ctx = createContext()
    ctx.push('A')
    ctx.evict([])
    assert.equal(ctx.messages.length, 1)
  })

  it('pinned flag preserved through serialize/restore', () => {
    const ctx = createContext()
    ctx.push('A')
    ctx.push('B')
    ctx.pin(0)

    const snapshot = ctx.serialize()
    const restored = createContext({ from: snapshot })
    assert.equal(restored.messages[0]!.pinned, true)
    assert.equal(restored.messages[1]!.pinned, undefined)
  })
})

// ── SlidingWindowStrategy ───────────────────────────────────────────────────

describe('SlidingWindowStrategy', () => {
  const strategy = new SlidingWindowStrategy()
  // Use a simple counter: 1 char = 1 token (easier to reason about in tests)
  const charCounter = (text: string) => text.length

  it('no eviction when under budget', () => {
    const ctx = createContext()
    ctx.push('short')
    ctx.push({ role: 'assistant', content: 'reply' })

    strategy.compact(ctx, 1000, charCounter)
    assert.equal(ctx.messages.length, 2)
  })

  it('evicts oldest non-pinned messages first', () => {
    const ctx = createContext()
    ctx.push('A'.repeat(100))  // 100 tokens
    ctx.push('B'.repeat(100))  // 100 tokens
    ctx.push('C'.repeat(100))  // 100 tokens

    // Budget of 250 → need to evict 50 tokens → evict first message (100 tokens)
    strategy.compact(ctx, 250, charCounter)
    assert.equal(ctx.messages.length, 2)
    assert.equal(ctx.messages[0]!.content, 'B'.repeat(100))
  })

  it('preserves pinned messages during eviction', () => {
    const ctx = createContext()
    ctx.push('A'.repeat(100))
    ctx.pin(0) // pin A
    ctx.push('B'.repeat(100))
    ctx.push('C'.repeat(100))

    // Budget of 150 → need to evict 100 tokens from non-pinned
    // A is pinned (not counted in budget), B should be evicted
    strategy.compact(ctx, 150, charCounter)
    assert.equal(ctx.messages.length, 2)
    assert.equal(ctx.messages[0]!.content, 'A'.repeat(100)) // pinned, preserved
    assert.equal(ctx.messages[1]!.content, 'C'.repeat(100))
  })

  it('evicts assistant + tool group as a unit', () => {
    const ctx = createContext()
    ctx.push('user question')
    ctx.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc1', name: 'my_tool', arguments: {} }],
    })
    ctx.push({ role: 'tool', content: 'R'.repeat(200), toolCallId: 'tc1' })
    ctx.push({ role: 'assistant', content: 'final answer' })

    // Budget tight enough to require evicting the tool call group
    strategy.compact(ctx, 50, charCounter)

    // User msg + tool group should be evicted, only final answer remains
    const remaining = ctx.messages
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0]!.content, 'final answer')
  })

  it('does not split tool call from its tool results', () => {
    const ctx = createContext()
    ctx.push({
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'tc1', name: 'tool_a', arguments: {} },
        { id: 'tc2', name: 'tool_b', arguments: {} },
      ],
    })
    ctx.push({ role: 'tool', content: 'result a', toolCallId: 'tc1' })
    ctx.push({ role: 'tool', content: 'result b', toolCallId: 'tc2' })
    ctx.push({ role: 'assistant', content: 'summary' })

    // Evict with tight budget — the whole group goes together
    strategy.compact(ctx, 20, charCounter)

    const remaining = ctx.messages
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0]!.content, 'summary')
  })

  it('pinned message inside tool group survives while rest is evicted', () => {
    const ctx = createContext()
    ctx.push({
      role: 'assistant',
      content: 'call it',
      toolCalls: [{ id: 'tc1', name: 'tool_a', arguments: {} }],
    })
    ctx.push({ role: 'tool', content: 'important result', toolCallId: 'tc1' })
    ctx.pin(-1) // pin the tool result
    ctx.push({ role: 'assistant', content: 'final' })

    strategy.compact(ctx, 30, charCounter)

    // The pinned tool result survives, the rest of the group is evicted
    const pinned = ctx.messages.filter(m => m.pinned)
    assert.equal(pinned.length, 1)
    assert.equal(pinned[0]!.content, 'important result')
  })

  it('all messages pinned → no eviction (nothing to evict)', () => {
    const ctx = createContext()
    ctx.push('A'.repeat(100))
    ctx.pin(0)
    ctx.push('B'.repeat(100))
    ctx.pin(1)

    // Budget of 10 but everything is pinned → strategy can't evict
    strategy.compact(ctx, 10, charCounter)
    assert.equal(ctx.messages.length, 2)
  })
})
