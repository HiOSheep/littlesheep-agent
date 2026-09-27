import type { ToolStreamEvent } from '@littlesheep/types'

// Tool arguments may contain an entire file. Keep one event well below the
// local SSE socket limit while retaining the path and an honest line count.
const MAX_TOOL_EVENT_BYTES = 32 * 1024

export function projectToolEventForStream(event: ToolStreamEvent): ToolStreamEvent {
  if (event.type !== 'tool_start' || !event.input) return event
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') <= MAX_TOOL_EVENT_BYTES) return event
  const input = isRecord(event.input) ? event.input : null
  const path = input && typeof input.file_path === 'string' ? input.file_path
    : input && typeof input.path === 'string' ? input.path : undefined
  const lineProgress = input ? lineDelta(event.name ?? '', input) : null
  return {
    ...event,
    input: { ...(path ? { file_path: path.slice(0, 2048) } : {}), truncated: true },
    ...(lineProgress ? { lineProgress } : {}),
  }
}

function lineDelta(name: string, input: Record<string, unknown>): ToolStreamEvent['lineProgress'] | null {
  const patch = firstString(input, ['patch', 'diff'])
  if (patch !== null) {
    let additions = 0
    let deletions = 0
    for (const line of patch.split(/\r?\n/u)) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
      if (line.startsWith('+')) additions += 1
      if (line.startsWith('-')) deletions += 1
    }
    return { additions, deletions }
  }
  const oldText = firstString(input, ['old_string', 'old_str', 'oldText', 'old_text'])
  const newText = firstString(input, ['new_string', 'new_str', 'newText', 'new_text'])
  if (/(?:^|_)(?:edit|replace|str_replace|modify|patch|multi_edit)/u.test(name.toLowerCase()) || (oldText !== null && newText !== null)) {
    if (oldText === null && newText === null) return null
    return { additions: newText === null ? 0 : countLines(newText), deletions: oldText === null ? null : countLines(oldText) }
  }
  const content = firstString(input, ['content', 'text', 'contents'])
  if (/(?:^|_)(?:write|create|save|append)/u.test(name.toLowerCase()) && content !== null) {
    return { additions: countLines(content), deletions: null }
  }
  return null
}

function countLines(value: string): number {
  if (!value) return 0
  const trimmed = value.replace(/\r\n/gu, '\n').replace(/\n+$/u, '')
  return trimmed ? trimmed.split('\n').length : 0
}

function firstString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) if (typeof input[key] === 'string') return input[key] as string
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
