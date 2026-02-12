/**
 * ContextNode — the atomic unit of context in a chain.
 * Holds content and metadata about its placement.
 */

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

/** Opaque typed handle — returned on creation, used for reference */
export type ContextNodeHandle = { readonly __brand: 'ContextNodeHandle'; readonly id: string }

let handleCounter = 0

export function createHandle(): ContextNodeHandle {
  return { __brand: 'ContextNodeHandle', id: `cn_${++handleCounter}` } as ContextNodeHandle
}

/** Reset counter — only for testing */
export function resetHandleCounter(): void {
  handleCounter = 0
}

// ---------------------------------------------------------------------------
// PinRule
// ---------------------------------------------------------------------------

export type PinRule =
  | { type: 'head'; priority?: number }
  | { type: 'tail'; priority?: number }
  | { type: 'floating' }
  | { type: 'after'; ref: ContextNodeHandle }
  | { type: 'before'; ref: ContextNodeHandle }

export const DEFAULT_PIN: PinRule = { type: 'floating' }

// ---------------------------------------------------------------------------
// ContextNode
// ---------------------------------------------------------------------------

export interface ContextNode<T = string> {
  readonly handle: ContextNodeHandle
  content: T
  pin: PinRule
  metadata?: Record<string, unknown>
}

export function createNode<T = string>(
  content: T,
  pin: PinRule = DEFAULT_PIN,
  metadata?: Record<string, unknown>,
): ContextNode<T> {
  return {
    handle: createHandle(),
    content,
    pin,
    metadata,
  }
}
