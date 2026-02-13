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
})
