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

  it('supports object parameter with nested properties', () => {
    const tool = createTool({
      id: 'create_user',
      description: 'Create a user',
      schema: {
        user: {
          type: 'object',
          description: 'The user to create',
          properties: {
            name: { type: 'string', description: 'Full name' },
            age: { type: 'number', description: 'Age', required: false },
          },
        },
      },
      execute: async (args) => args,
    })

    const spec = tool.spec
    assert.equal(spec.parameters.user!.type, 'object')
    assert.equal(spec.parameters.user!.properties!.name.type, 'string')
    assert.equal(spec.parameters.user!.properties!.age.required, false)
  })

  it('supports array parameter with items schema', () => {
    const tool = createTool({
      id: 'sum',
      description: 'Sum numbers',
      schema: {
        numbers: {
          type: 'array',
          description: 'List of numbers to sum',
          items: { type: 'number', description: 'A number' },
        },
      },
      execute: async (args) => args,
    })

    const spec = tool.spec
    assert.equal(spec.parameters.numbers!.type, 'array')
    assert.equal(spec.parameters.numbers!.items!.type, 'number')
  })

  it('supports enum on string parameters', () => {
    const tool = createTool({
      id: 'set_priority',
      description: 'Set priority level',
      schema: {
        level: {
          type: 'string',
          description: 'Priority',
          enum: ['low', 'medium', 'high'],
        },
      },
      execute: async (args) => args,
    })

    const spec = tool.spec
    assert.deepStrictEqual(spec.parameters.level!.enum, ['low', 'medium', 'high'])
  })

  it('supports deeply nested composition (object → array → object)', () => {
    const tool = createTool({
      id: 'create_order',
      description: 'Create an order',
      schema: {
        order: {
          type: 'object',
          description: 'The order',
          properties: {
            items: {
              type: 'array',
              description: 'Line items',
              items: {
                type: 'object',
                description: 'A line item',
                properties: {
                  sku: { type: 'string', description: 'SKU' },
                  qty: { type: 'number', description: 'Quantity' },
                },
              },
            },
          },
        },
      },
      execute: async (args) => args,
    })

    const spec = tool.spec
    const orderParam = spec.parameters.order!
    assert.equal(orderParam.type, 'object')
    const itemsParam = orderParam.properties!.items
    assert.equal(itemsParam.type, 'array')
    assert.equal(itemsParam.items!.type, 'object')
    assert.equal(itemsParam.items!.properties!.sku.type, 'string')
    assert.equal(itemsParam.items!.properties!.qty.type, 'number')
  })
})

