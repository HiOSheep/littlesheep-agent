// Bounded, numeric-only projection of a tool call while its JSON arguments arrive.
// This is provisional: the completed tool call remains the authority for final counts.
export interface ToolArgumentLineProgress {
  additions: number
  deletions: number | null
}

export const MAX_PROGRESS_ARGUMENT_CHARACTERS = 64_000

export function toolArgumentLineProgress(name: string, argumentsSoFar: string): ToolArgumentLineProgress | null {
  const tool = name.toLowerCase()
  if (/(?:^|_)(?:edit|replace|str_replace|modify|patch|multi_edit)/u.test(tool)) {
    const patch = stringField(argumentsSoFar, 'patch') ?? stringField(argumentsSoFar, 'diff')
    if (patch !== null) return patchProgress(patch)
    const newer = stringField(argumentsSoFar, 'new_string') ?? stringField(argumentsSoFar, 'new_str')
    const older = stringField(argumentsSoFar, 'old_string') ?? stringField(argumentsSoFar, 'old_str')
    if (newer === null && older === null) return null
    return { additions: lineCount(newer ?? ''), deletions: older === null ? null : lineCount(older) }
  }
  if (/(?:^|_)(?:write|create|save|append)/u.test(tool)) {
    const content = stringField(argumentsSoFar, 'content') ?? stringField(argumentsSoFar, 'text')
    return content === null ? null : { additions: lineCount(content), deletions: null }
  }
  return null
}

/** A short, human-readable target. Never expose a file body or full argument JSON. */
export function toolArgumentSummary(argumentsSoFar: string): string | null {
  for (const key of ['file_path', 'path', 'command', 'cmd', 'query', 'pattern', 'url']) {
    const value = stringField(argumentsSoFar, key)
    if (value?.trim()) return value.trim().slice(0, 240)
  }
  return null
}

// Read only a named JSON string value; an unfinished value is decoded up to the last
// complete escape. The parser never emits source text, only counts derived from it.
function stringField(source: string, key: string): string | null {
  const match = new RegExp(`"${key}"\\s*:\\s*"`, 'u').exec(source)
  if (!match) return null
  let value = ''
  for (let index = match.index + match[0].length; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"') return value
    if (character !== '\\') { value += character; continue }
    const escape = source[++index]
    if (escape === undefined) break
    if (escape === 'u') {
      const hex = source.slice(index + 1, index + 5)
      if (!/^[0-9a-fA-F]{4}$/u.test(hex)) break
      value += String.fromCharCode(Number.parseInt(hex, 16))
      index += 4
    } else {
      value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[escape] ?? escape
    }
  }
  return value
}

function lineCount(value: string): number {
  if (!value) return 0
  const normalized = value.replace(/\r\n/gu, '\n').replace(/\n+$/u, '')
  return normalized ? normalized.split('\n').length : 0
}

function patchProgress(patch: string): ToolArgumentLineProgress | null {
  let additions = 0
  let deletions = 0
  for (const line of patch.split(/\r?\n/u)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions += 1
    if (line.startsWith('-')) deletions += 1
  }
  return additions || deletions ? { additions, deletions } : null
}
