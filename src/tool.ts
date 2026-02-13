/**
 * Cog v2 — Tool
 *
 * A tool is a schema + execute function. Everything is a tool.
 */

import type { Context } from './context.js'
import type { ToolParameter, ToolSpec } from './types.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type ToolConfig<TArgs = Record<string, unknown>> = {
  id: string
  description: string
  schema?: Record<string, ToolParameter>
  execute: (args: TArgs, ctx: Context) => Promise<unknown>
}

// ── Tool ────────────────────────────────────────────────────────────────────

export class Tool<TArgs = Record<string, unknown>> {
  readonly id: string
  readonly description: string
  readonly schema: Record<string, ToolParameter>
  readonly execute: (args: TArgs, ctx: Context) => Promise<unknown>

  constructor(config: ToolConfig<TArgs>) {
    this.id = config.id
    this.description = config.description
    this.schema = config.schema ?? {}
    this.execute = config.execute
  }

  /** Tool specification for the provider (OpenAI-compatible format) */
  get spec(): ToolSpec {
    return {
      name: this.id,
      description: this.description,
      parameters: this.schema,
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createTool<TArgs = Record<string, unknown>>(
  config: ToolConfig<TArgs>,
): Tool<TArgs> {
  return new Tool(config)
}
