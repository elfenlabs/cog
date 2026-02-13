import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTool } from './tool.js'

describe('Tool', () => {
  it('createTool returns a tool with correct id and description', () => {
    const tool = createTool({
      id: 'greet',
      description: 'Say hello',
      schema: {
        name: { type: 'string', description: 'Name to greet' },
      },
      execute: async (args) => `Hello, ${(args as any).name}!`,
    })

    assert.equal(tool.id, 'greet')
    assert.equal(tool.description, 'Say hello')
  })

  it('spec returns provider-compatible format', () => {
    const tool = createTool({
      id: 'add',
      description: 'Add two numbers',
      schema: {
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' },
      },
      execute: async (args) => (args as any).a + (args as any).b,
    })

    assert.deepStrictEqual(tool.spec, {
      name: 'add',
      description: 'Add two numbers',
      parameters: {
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' },
      },
    })
  })

  it('schema defaults to empty object if omitted', () => {
    const tool = createTool({
      id: 'noop',
      description: 'Does nothing',
      execute: async () => null,
    })

    assert.deepStrictEqual(tool.schema, {})
    assert.deepStrictEqual(tool.spec.parameters, {})
  })

  it('execute is callable', async () => {
    const tool = createTool({
      id: 'double',
      description: 'Double a number',
      schema: { n: { type: 'number', description: 'The number' } },
      execute: async (args) => (args as any).n * 2,
    })

    const result = await tool.execute({ n: 5 } as any, {} as any)
    assert.equal(result, 10)
  })
})
