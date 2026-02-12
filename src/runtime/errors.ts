/**
 * Error types for the Cog runtime.
 */

export class GraphControlError extends Error {
  constructor(
    message: string,
    public readonly nodeId?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'GraphControlError'
  }
}

export class SerializationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SerializationError'
  }
}
