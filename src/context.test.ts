import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createContext } from './context.js'

describe('Context', () => {
  it('push(string) creates a user message', () => {
    const ctx = createContext()
    ctx.push('hello')
    assert.equal(ctx.messages.length, 1)
    assert.deepStrictEqual(ctx.messages[0], { role: 'user', content: 'hello' })
  })

  it('push(Message) stores the message as-is', () => {
    const ctx = createContext()
    ctx.push({ role: 'assistant', content: 'hi' })
    assert.equal(ctx.messages.length, 1)
    assert.deepStrictEqual(ctx.messages[0], { role: 'assistant', content: 'hi' })
  })

  it('push(Message) preserves toolCallId and toolCalls', () => {
    const ctx = createContext()
    ctx.push({
      role: 'tool',
      content: '{"result": 42}',
      toolCallId: 'call_1',
    })
    assert.equal(ctx.messages[0]!.toolCallId, 'call_1')
  })

  it('messages returns all pushed messages in order', () => {
    const ctx = createContext()
    ctx.push('one')
    ctx.push('two')
    ctx.push('three')
    assert.equal(ctx.messages.length, 3)
    assert.equal(ctx.messages[0]!.content, 'one')
    assert.equal(ctx.messages[2]!.content, 'three')
  })

  it('serialize/deserialize round-trip preserves messages', () => {
    const ctx = createContext()
    ctx.push('hello')
    ctx.push({ role: 'assistant', content: 'world' })

    const snapshot = ctx.serialize()
    const restored = createContext({ from: snapshot })

    assert.deepStrictEqual(restored.messages, ctx.messages)
  })

  it('deserialized context is a deep copy (mutation-safe)', () => {
    const ctx = createContext()
    ctx.push('original')

    const snapshot = ctx.serialize()
    const restored = createContext({ from: snapshot })
    restored.push('added')

    assert.equal(ctx.messages.length, 1)
    assert.equal(restored.messages.length, 2)
  })

  it('fork() inherits parent messages', () => {
    const parent = createContext()
    parent.push('A')
    parent.push('B')

    const child = parent.fork()
    child.push('C')

    assert.equal(child.messages.length, 3)
    assert.equal(child.messages[0]!.content, 'A')
    assert.equal(child.messages[1]!.content, 'B')
    assert.equal(child.messages[2]!.content, 'C')
  })

  it('fork() push is isolated from parent', () => {
    const parent = createContext()
    parent.push('A')

    const child = parent.fork()
    child.push('X')
    child.push('Y')

    assert.equal(parent.messages.length, 1)
    assert.equal(child.messages.length, 3)
  })

  it('fork() serialize flattens the chain', () => {
    const parent = createContext()
    parent.push('A')

    const child = parent.fork()
    child.push('B')

    const snapshot = child.serialize()
    assert.equal(snapshot.messages.length, 2)
    assert.equal(snapshot.messages[0]!.content, 'A')
    assert.equal(snapshot.messages[1]!.content, 'B')
  })

  it('nested fork() chains correctly', () => {
    const grandparent = createContext()
    grandparent.push('A')

    const parent = grandparent.fork()
    parent.push('B')

    const child = parent.fork()
    child.push('C')

    assert.equal(child.messages.length, 3)
    assert.equal(child.messages[0]!.content, 'A')
    assert.equal(child.messages[1]!.content, 'B')
    assert.equal(child.messages[2]!.content, 'C')

    // grandparent and parent remain untouched
    assert.equal(grandparent.messages.length, 1)
    assert.equal(parent.messages.length, 2)
  })

  it('push(ContentPart[]) creates a user message with array content', () => {
    const ctx = createContext()
    const parts = [
      { type: 'text' as const, text: 'What is this?' },
      { type: 'image_url' as const, image_url: { url: 'https://example.com/img.png' } },
    ]
    ctx.push(parts)
    assert.equal(ctx.messages.length, 1)
    assert.equal(ctx.messages[0]!.role, 'user')
    assert.deepStrictEqual(ctx.messages[0]!.content, parts)
  })
})

