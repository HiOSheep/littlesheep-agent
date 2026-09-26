// Whether a similar memory may actually be merged, or only looked at.
//
// Similarity is a bag-of-terms ratio: "the port is 5432" and "the port is 6432" score 0.92 while
// saying different things, and the same is true of a fact and its negation with one extra word. The
// repository used to merge anything above the threshold, which meant a changed fact was recorded as
// "merged", the old body stayed current, and the new source was attached to a statement it does not
// support (measured on this defect: similarity 0.9167, retrievable body unchanged, new source
// appended).
//
// So this module answers one question — may these two statements be treated as the same fact — and it
// errs towards "no". A refused merge is not a lost write: the caller decides what to do (the first
// version of the controlled write path rejects with a conflict report and keeps the old record).

export interface MergeGuardInput {
  existingSummary: string
  existingContent: string
  incomingSummary: string
  incomingContent: string
  existingEntityRefs?: readonly string[]
  incomingEntityRefs?: readonly string[]
}

export type MergeGuardVerdict =
  | { ok: true }
  | { ok: false; reason: MergeConflictReason; detail: string }

export type MergeConflictReason = 'different-values' | 'negation' | 'different-entities'

/** Numeric tokens as they appear, normalized so 5,432 and 5432 are the same value. */
export function memoryStatementValues(text: string): Set<string> {
  const values = new Set<string>()
  for (const match of text.matchAll(/\d[\d,_.]*/gu)) {
    const normalized = match[0].replace(/[,_]/gu, '').replace(/\.$/u, '')
    if (normalized) values.add(normalized)
  }
  return values
}

const NEGATIONS = [
  '不', '没', '没有', '无', '未', '别', '禁止', '取消', '关闭', '非',
  'not', 'no', 'never', 'without', 'disable', 'disabled', 'off', 'deny', 'denied',
]

/** True when the text carries an explicit negation. Kept deliberately broad. */
export function hasNegation(text: string): boolean {
  const lower = ` ${text.toLowerCase()} `
  return NEGATIONS.some((token) => lower.includes(token))
}

export function mayMergeMemoryStatements(input: MergeGuardInput): MergeGuardVerdict {
  const existingText = `${input.existingSummary}\n${input.existingContent}`
  const incomingText = `${input.incomingSummary}\n${input.incomingContent}`

  const existingValues = memoryStatementValues(existingText)
  const incomingValues = memoryStatementValues(incomingText)
  // A value that appears on one side only is the clearest signal that these are two different facts:
  // 5432 versus 6432, 3 retries versus 5.
  const onlyExisting = [...existingValues].filter((value) => !incomingValues.has(value))
  const onlyIncoming = [...incomingValues].filter((value) => !existingValues.has(value))
  if (existingValues.size > 0 && incomingValues.size > 0 && (onlyExisting.length > 0 || onlyIncoming.length > 0)) {
    return {
      ok: false,
      reason: 'different-values',
      detail: `different values (${[...onlyExisting, ...onlyIncoming].join(', ')})`,
    }
  }

  // A negation on exactly one side turns a statement into its opposite.
  if (hasNegation(existingText) !== hasNegation(incomingText)) {
    return { ok: false, reason: 'negation', detail: 'one side is negated and the other is not' }
  }

  // Two non-empty, disjoint entity sets are two different subjects, however similar the wording.
  const existingEntities = new Set(input.existingEntityRefs ?? [])
  const incomingEntities = new Set(input.incomingEntityRefs ?? [])
  if (existingEntities.size > 0 && incomingEntities.size > 0) {
    const shared = [...incomingEntities].some((entity) => existingEntities.has(entity))
    if (!shared) {
      return {
        ok: false,
        reason: 'different-entities',
        detail: `no shared entity (${[...incomingEntities].join(', ')})`,
      }
    }
  }

  return { ok: true }
}
