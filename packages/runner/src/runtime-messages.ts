// The Runtime's own sentences, in the interface language (audit #18, architecture A1).
//
// When a run stops without publishing a final reply, the answer slot still owes the reader one
// sentence: what the Runtime did and what to do next. Those sentences are Runtime facts — AGENTS.md
// keeps Runtime state out of the model's voice, so they are never dressed up as an Agent reply —
// and the desktop interface is Chinese, which is why they cannot be English literals at the point
// of use.
//
// This is a message catalogue, not an i18n layer. The key *is* the sentence the catalogue replaces,
// so an entry that is missing falls back to exactly the text that was published before the
// catalogue existed, and no caller can invent a key that has no original. There is no locale
// switching and there is no second language.
//
// The internal reason code is not part of any sentence: it stays in `RuntimeFinalStatus.reason`
// (the durable `runtime_status_settled` event and the execution log) where diagnostics read it.
// `scripts/verify-runtime-message-catalogue.mjs` fails when a user-facing sentence the Runner
// publishes is not in this catalogue.

/** Sentence the catalogue replaces -> the sentence a user reads. */
export const RUNTIME_MESSAGE_CATALOGUE: Readonly<Record<string, string>> = Object.freeze({
  'Runtime is waiting for user action; no final reply was published.':
    '本轮运行在等待你的决定时停下，没有发布最终回复。请回复你的决定，或重新发送这条消息。',
  'Runtime interrupted before publishing a final reply.':
    '本轮运行已停止，没有发布最终回复。你可以重新发送这条消息继续。',
  'Runtime failed before publishing a final reply.':
    '本轮运行失败，没有发布最终回复。你可以重新发送这条消息重试。',
})

/**
 * The sentence a user reads for a Runtime sentence that may be covered by the catalogue.
 *
 * An un-catalogued sentence is returned unchanged: the Runtime must never fail, and must never show
 * a key, because an entry is missing — the gate is where a missing entry is an error.
 */
export function runtimeUserSentence(
  sentence: string,
  catalogue: Readonly<Record<string, string>> = RUNTIME_MESSAGE_CATALOGUE,
): string {
  return catalogue[sentence] ?? sentence
}
