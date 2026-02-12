/**
 * Transition — edge between action nodes in the control flow graph.
 */

import type { SideChannel } from '../runtime/side-channel.js'

export interface TransitionDefinition<TOutput = unknown, TInput = unknown> {
  to: string
  on?: string
  when?: (output: TOutput, side: SideChannel) => boolean
  map?: (output: TOutput) => TInput
}
