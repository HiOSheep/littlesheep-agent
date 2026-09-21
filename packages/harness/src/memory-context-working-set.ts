import type { ChatMessage, ChatRequest } from '@littlesheep/llm';
import type { ContextMessageCandidate } from '@littlesheep/context';
import type { RunContext, RuntimeMemoryContextWorkingSet, ToolResult } from '@littlesheep/types';
import { writeMemoryState } from './memory-state.js';
import { CACHE_BOUNDARY_MARKER } from '@littlesheep/prompt';
import type { RunContextContractStage } from '@littlesheep/types';

const MAX_MEMORY_CONTEXT_ATOMS = 128;
const MAX_MEMORY_CONTEXT_CALLS = 64;

export function ingestMemoryContextToolResult(
  ctx: RunContext,
  callId: string,
  result: ToolResult,
  stage: RunContextContractStage = 'execute',
): void {
  const state: RuntimeMemoryContextWorkingSet = structuredClone(ctx.memoryContextWorkingSet ?? {
    revision: 0,
    activeAtomIds: [],
    releasedAtomIds: [],
    activeCallByAtom: {},
    callAtomIds: {},
    updatedAt: new Date().toISOString(),
  });
  const fragmentIds = stringArray(result.meta?.memoryFragmentIds);
  const releasedIds = stringArray(result.meta?.memoryReleasedAtomIds);
  let changed = false;
  if (fragmentIds.length > 0) {
    state.callAtomIds[callId] = fragmentIds.slice(0, MAX_MEMORY_CONTEXT_ATOMS);
    for (const atomId of fragmentIds) state.activeCallByAtom[atomId] = callId;
    changed = true;
  }
  if (releasedIds.length > 0) {
    for (const atomId of releasedIds) delete state.activeCallByAtom[atomId];
    changed = true;
  }
  if (!changed) return;
  boundCallMap(state.callAtomIds);
  const active = Object.keys(state.activeCallByAtom).slice(-MAX_MEMORY_CONTEXT_ATOMS);
  state.activeCallByAtom = Object.fromEntries(active.map((atomId) => [atomId, state.activeCallByAtom[atomId]!]));
  state.activeAtomIds = active;
  state.releasedAtomIds = unique([
    ...state.releasedAtomIds,
    ...releasedIds,
  ]).filter((atomId) => !state.activeCallByAtom[atomId]).slice(-MAX_MEMORY_CONTEXT_ATOMS);
  state.revision += 1;
  state.updatedAt = new Date().toISOString();
  writeMemoryState(ctx, stage, { memoryContextWorkingSet: state });
}

/**
 * Append-only release semantics.
 *
 * Rewriting earlier text (system prompt or tool results) invalidates the
 * Provider's prefix cache from the rewritten byte onwards, so released memory
 * stays in place and the runtime appends one release note instead. The note is
 * the authoritative fact: the listed atoms must not be used as active evidence.
 */
export function appendMemoryReleaseNotes(
  ctx: RunContext,
  request: ChatRequest,
  candidates?: ContextMessageCandidate[],
): { request: ChatRequest; candidates?: ContextMessageCandidate[] } {
  const ids = releasedAtomIdsFromWorkingSet(ctx.memoryContextWorkingSet);
  if (ids.length === 0) return { request, candidates };
  const message: ChatMessage = { role: 'system', content: memoryReleaseNoteText(ids) };
  const preparedRequest = { ...request, messages: [...request.messages, message] };
  if (!candidates) return { request: preparedRequest };
  return {
    request: preparedRequest,
    candidates: [...candidates, {
      id: `memory-release-note:${ids.join(',')}`,
      order: Number.MAX_SAFE_INTEGER - 2,
      message,
      kind: 'memory_fragment',
      source: { kind: 'memory', id: `release-note:${ids.join(',')}`, runId: ctx.runId },
      priority: 99,
      required: true,
      sensitive: true,
      scope: 'run',
    }],
  };
}

/** Atoms whose memory context is no longer active under the working-set rule. */
export function releasedAtomIdsFromWorkingSet(
  state: RunContext['memoryContextWorkingSet'],
): string[] {
  if (!state || Object.keys(state.callAtomIds).length === 0) return [];
  const released = new Set<string>();
  for (const [callId, atomIds] of Object.entries(state.callAtomIds)) {
    for (const atomId of atomIds) {
      if (state.activeCallByAtom[atomId] !== callId) released.add(atomId);
    }
  }
  return [...released].sort();
}

/** The exact release note text, shared by every path that appends one. */
export function memoryReleaseNoteText(ids: readonly string[]): string {
  return `${CACHE_BOUNDARY_MARKER}\n\n# Released Memory\n\n`
    + `- released_atoms: ${ids.join(', ')}\n`
    + '- Earlier tool results and the system prompt still contain their original text; history is append-only.\n'
    + '- Treat every released atom as inactive evidence: do not cite it, and do not use it to justify the answer.\n';
}

export function applyMemoryContextWorkingSet(
  ctx: RunContext,
  request: ChatRequest,
  candidates?: ContextMessageCandidate[],
): { request: ChatRequest; candidates?: ContextMessageCandidate[] } {
  const state = ctx.memoryContextWorkingSet;
  if (!state || Object.keys(state.callAtomIds).length === 0) return { request, candidates };
  // Filter by each message's own role/tool-call identity instead of its index in
  // the request array: trailing Context messages live outside request.messages
  // and must still lose released memory.
  const initialInactive = new Set((state.callAtomIds.initial ?? [])
    .filter((atomId) => state.activeCallByAtom[atomId] !== 'initial'));
  const filterMessage = (message: ChatMessage): ChatMessage | undefined => {
    if (typeof message.content !== 'string') return undefined;
    if (message.role === 'system') {
      if (initialInactive.size === 0) return undefined;
      const content = filterRenderedMemory(message.content, initialInactive);
      return content === message.content ? undefined : { ...message, content };
    }
    if (message.role !== 'tool' || !message.tool_call_id) return undefined;
    const atomIds = state.callAtomIds[message.tool_call_id];
    if (!atomIds?.length) return undefined;
    const inactive = new Set(atomIds.filter((atomId) => state.activeCallByAtom[atomId] !== message.tool_call_id));
    if (inactive.size === 0) return undefined;
    const content = filterToolResultContent(message.content, inactive);
    return content === message.content ? undefined : { ...message, content };
  };

  let changed = false;
  const messages = request.messages.map((message) => {
    const filtered = filterMessage(message);
    if (!filtered) return message;
    changed = true;
    return filtered;
  });
  const filteredCandidates = candidates?.map((candidate) => {
    let next = candidate;
    const filteredMessage = filterMessage(candidate.message);
    if (filteredMessage) {
      changed = true;
      next = { ...next, message: filteredMessage };
    }
    if (next.segments && initialInactive.size > 0) {
      const segments = next.segments.map((segment) => {
        if (segment.source.kind !== 'memory' || segment.source.id !== 'initial-selection') return segment;
        const text = filterRenderedMemory(segment.text, initialInactive);
        if (text === segment.text) return segment;
        changed = true;
        return { ...segment, text };
      });
      next = { ...next, segments };
    }
    return next;
  });
  if (!changed) return { request, candidates };
  return { request: { ...request, messages }, candidates: filteredCandidates };
}

function filterToolResultContent(content: string, inactiveAtomIds: Set<string>): string {
  try {
    const payload = JSON.parse(content) as { output?: unknown };
    if (typeof payload.output !== 'string') return content;
    payload.output = filterRenderedMemory(payload.output, inactiveAtomIds);
    return JSON.stringify(payload);
  } catch {
    return content;
  }
}

function filterRenderedMemory(output: string, inactiveAtomIds: Set<string>): string {
  const lines = output.split('\n');
  if (lines.some((line) => line.startsWith('<!-- littlesheep-memory-atom:start '))) {
    return filterMarkedMemory(lines, inactiveAtomIds);
  }
  const retained: string[] = [];
  let suppress = false;
  let removed = 0;
  let noticeIndex = -1;
  for (const line of lines) {
    const headingEnd = line.startsWith('## [') ? line.indexOf(']', 4) : -1;
    if (headingEnd > 4) {
      if (suppress && noticeIndex < 0) noticeIndex = insertReleaseNotice(retained);
      suppress = inactiveAtomIds.has(line.slice(4, headingEnd));
      if (suppress) removed += 1;
    } else if (line === '# Child Index' || line === '---' || line.startsWith('# ')) {
      if (suppress && noticeIndex < 0) noticeIndex = insertReleaseNotice(retained);
      suppress = false;
    }
    if (!suppress) retained.push(line);
  }
  if (suppress && noticeIndex < 0) noticeIndex = insertReleaseNotice(retained);
  updateReleaseNotice(retained, noticeIndex, removed);
  return retained.join('\n');
}

function filterMarkedMemory(lines: string[], inactiveAtomIds: Set<string>): string {
  const retained: string[] = [];
  let suppress = false;
  let removed = 0;
  let noticeIndex = -1;
  for (const line of lines) {
    const startId = markerAtomId(line, 'start');
    if (startId) {
      suppress = inactiveAtomIds.has(startId);
      if (suppress) removed += 1;
      if (!suppress) retained.push(line);
      continue;
    }
    const endId = markerAtomId(line, 'end');
    if (endId) {
      if (!suppress) retained.push(line);
      else if (noticeIndex < 0) noticeIndex = insertReleaseNotice(retained);
      suppress = false;
      continue;
    }
    if (!suppress) retained.push(line);
  }
  if (suppress && noticeIndex < 0) noticeIndex = insertReleaseNotice(retained);
  updateReleaseNotice(retained, noticeIndex, removed);
  return retained.join('\n');
}

function insertReleaseNotice(retained: string[]): number {
  retained.push('');
  const index = retained.length;
  retained.push('');
  return index;
}

function updateReleaseNotice(retained: string[], index: number, removed: number): void {
  if (index < 0 || removed <= 0) return;
  retained[index] = `[${removed} memory atom section(s) released from the active run context.]`;
}

function markerAtomId(line: string, boundary: 'start' | 'end'): string | undefined {
  const prefix = `<!-- littlesheep-memory-atom:${boundary} `;
  if (!line.startsWith(prefix) || !line.endsWith(' -->')) return undefined;
  const atomId = line.slice(prefix.length, -4).trim();
  return atomId || undefined;
}

function boundCallMap(value: Record<string, string[]>): void {
  const callIds = Object.keys(value);
  while (callIds.length > MAX_MEMORY_CONTEXT_CALLS) delete value[callIds.shift()!];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? unique(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))
    : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
