/**
 * Nous — AgentRunHandle
 *
 * A thenable handle returned by runAgent() that exposes real-time
 * loop state while remaining fully await-able.
 */

import type { AgentResult } from './agent.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type RunState = 'thinking' | 'tool_call' | 'done' | 'error'

export type ActiveToolCall = {
  id: string
  toolId: string
  args: Record<string, unknown>
  startedAt: Date
}

export type RunStatus = {
  state: RunState
  step: number
  activeToolCalls: ActiveToolCall[]
}

// ── Handle ──────────────────────────────────────────────────────────────────

export class AgentRunHandle implements PromiseLike<AgentResult> {
  private _state: RunState = 'thinking'
  private _step: number = 0
  private _activeToolCalls: ActiveToolCall[] = []
  private _listeners: Set<(status: RunStatus) => void> = new Set()
  private _promise!: Promise<AgentResult>

  /** @internal — kick off the loop after the handle is fully constructed */
  _start(executor: () => Promise<AgentResult>): void {
    this._promise = executor()
  }

  /** Sync snapshot of current loop state */
  status(): RunStatus {
    return {
      state: this._state,
      step: this._step,
      activeToolCalls: [...this._activeToolCalls],
    }
  }

  /** Subscribe to state transitions. Returns an unsubscribe function. */
  onChange(cb: (status: RunStatus) => void): () => void {
    this._listeners.add(cb)
    return () => this._listeners.delete(cb)
  }

  /** PromiseLike — makes `await run` work */
  then<TResult1 = AgentResult, TResult2 = never>(
    onfulfilled?: ((value: AgentResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this._promise.then(onfulfilled, onrejected)
  }

  // ── Internal mutation (called by the loop) ────────────────────────────

  /** @internal */
  _transition(state: RunState, step?: number): void {
    this._state = state
    if (step !== undefined) this._step = step
    if (state === 'done' || state === 'error') {
      this._activeToolCalls = []
    }
    this._notify()
  }

  /** @internal */
  _setActiveToolCalls(calls: ActiveToolCall[]): void {
    this._activeToolCalls = calls
    this._notify()
  }

  /** @internal */
  _clearActiveToolCalls(): void {
    this._activeToolCalls = []
    this._notify()
  }

  private _notify(): void {
    const snapshot = this.status()
    for (const cb of this._listeners) {
      cb(snapshot)
    }
  }
}
