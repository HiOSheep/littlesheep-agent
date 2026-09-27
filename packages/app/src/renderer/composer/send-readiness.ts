// When the composer must refuse to send, and why.
//
// Sending dispatches a real run. With no usable model the Runtime accepts that
// request and then has nothing that can answer it: measured on a real window with
// a fresh data root, the turn sat at 正在工作 · 1m 14s with zero characters
// streamed and no settlement, because the configured model ref pointed at a
// provider without a key. ChatGPT, Cursor and VS Code all refuse that submit and
// point at model setup instead of dispatching to a provider that cannot answer.
//
// The two facts already exist and are not re-invented here:
//   - `runtime-availability.ts` owns why nothing is selectable, including the
//     action that fixes it (`配置模型` / `检查供应商配置` / `重试读取`);
//   - the Runtime readiness owns whether execution is possible at all.
// This module combines them once, so the send control, its tooltip, the empty
// conversation copy and the picker cannot disagree about whether sending works.

import type { RuntimeAvailability } from './runtime-availability'

export interface ComposerSendReadiness {
  /** True when a send would start a run the Runtime cannot finish. */
  blocked: boolean
  /** The Runtime's own reason, while execution itself is unavailable. */
  executionReason: string | null
  /** Why the composer's model prerequisite is unmet, when it is. */
  modelReason: string | null
  /** One sentence for the disabled control: whichever of the two applies. */
  reason: string | null
  /** Where the user is sent to fix it. */
  action: 'none' | 'configure' | 'retry'
  actionLabel: string
}

export function describeComposerSendReadiness(input: {
  availability: RuntimeAvailability
  /** The Runtime readiness reason; non-null while execution is unavailable. */
  executionReason: string | null
}): ComposerSendReadiness {
  // `loading` counts as blocked on purpose: the configuration has not been read
  // yet, so "a model is usable" is not yet a fact, and the default model ref is
  // exactly the one that cannot answer on a fresh root.
  const modelReason = input.availability.kind === 'ready' ? null : input.availability.detail
  return {
    blocked: input.executionReason !== null || modelReason !== null,
    executionReason: input.executionReason,
    modelReason,
    reason: input.executionReason ?? modelReason,
    action: input.availability.action,
    actionLabel: input.availability.actionLabel,
  }
}
