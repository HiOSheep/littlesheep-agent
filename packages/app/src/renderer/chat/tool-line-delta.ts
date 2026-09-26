// How many lines a file-writing tool call added and removed, for the transcript row.
//
// The numbers are read from the call's own arguments, which is also what makes them live: while the
// arguments are still arriving, `content` / `new_string` grow, the count grows with them, and the
// reader watches the edit add up instead of seeing a number appear at the end.
//
// Honesty rules: a number is only shown when the arguments really carry it. `write` reports additions
// and no deletions (the previous file, if any, is not in the call), `edit` reports both sides, a patch
// is counted line by line, and anything else reports nothing at all rather than a guess.

export interface ToolLineDelta {
  additions: number
  /** Null when the call cannot say: an overwritten file's old lines are not part of the arguments. */
  deletions: number | null
}

const WRITE_TOOLS = /(?:^|_)(?:write|create|save|append)/u
const EDIT_TOOLS = /(?:^|_)(?:edit|replace|str_replace|modify|patch|multi_edit)/u

export function toolLineDelta(name: string, input: unknown): ToolLineDelta | null {
  const tool = name.toLowerCase()
  const record = isRecord(input) ? input : null
  if (!record) return null

  const patch = firstString(record, ['patch', 'diff'])
  if (patch) return patchDelta(patch)

  const oldText = firstString(record, ['old_string', 'old_str', 'oldText', 'old_text'])
  const newText = firstString(record, ['new_string', 'new_str', 'newText', 'new_text'])
  if (EDIT_TOOLS.test(tool) || (oldText !== null && newText !== null)) {
    if (oldText === null && newText === null) return null
    if (oldText !== null && newText !== null && oldText === newText) return null
    return {
      additions: newText === null ? 0 : countLines(newText),
      deletions: oldText === null ? null : countLines(oldText),
    }
  }

  const content = firstString(record, ['content', 'text', 'contents'])
  if (WRITE_TOOLS.test(tool) && content !== null) {
    return { additions: countLines(content), deletions: null }
  }

  return null
}

/** `+`/`-` lines of a unified diff, ignoring the file headers. */
export function patchDelta(patch: string): ToolLineDelta | null {
  let additions = 0
  let deletions = 0
  let seen = false
  for (const line of patch.split(/\r?\n/u)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) {
      additions += 1
      seen = true
      continue
    }
    if (line.startsWith('-')) {
      deletions += 1
      seen = true
    }
  }
  return seen ? { additions, deletions } : null
}

/** A trailing newline is a terminator, not an empty last line. */
export function countLines(text: string): number {
  if (!text) return 0
  const normalized = text.replace(/\r\n/gu, '\n').replace(/\n+$/u, '')
  return normalized ? normalized.split('\n').length : 0
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
