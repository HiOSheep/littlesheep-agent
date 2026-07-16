import type { ChatMessage, ChatRequest } from '@littlesheep/llm';
import type { ContextMessageCandidate } from '@littlesheep/context';
import type { RunContext, ToolResult } from '@littlesheep/types';

const MAX_MEMORY_CONTEXT_ATOMS = 128;
const MAX_MEMORY_CONTEXT_CALLS = 64;

export function ingestMemoryContextToolResult(
  ctx: RunContext,
  callId: string,
  result: ToolResult,
): void {
  const state = ctx.memoryContextWorkingSet ??= {
    revision: 0,
    activeAtomIds: [],
    releasedAtomIds: [],
    activeCallByAtom: {},
    callAtomIds: {},
    updatedAt: new Date().toISOString(),
  };
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
}

export function applyMemoryContextWorkingSet(
  ctx: RunContext,
  request: ChatRequest,
  candidates?: ContextMessageCandidate[],
): { request: ChatRequest; candidates?: ContextMessageCandidate[] } {
  const state = ctx.memoryContextWorkingSet;
  if (!state || Object.keys(state.callAtomIds).length === 0) return { request, candidates };
  const replacements = new Map<number, ChatMessage>();
  request.messages.forEach((message, index) => {
    if (message.role === 'system' && typeof message.content === 'string') {
      const initialAtomIds = state.callAtomIds.initial;
      if (!initialAtomIds?.length) return;
      const inactive = initialAtomIds.filter((atomId) => state.activeCallByAtom[atomId] !== 'initial');
      if (inactive.length > 0) {
        replacements.set(index, {
          ...message,
          content: filterRenderedMemory(message.content, new Set(inactive)),
        });
      }
      return;
    }
    if (message.role !== 'tool' || !message.tool_call_id) return;
    const atomIds = state.callAtomIds[message.tool_call_id];
    if (!atomIds?.length) return;
    const inactive = atomIds.filter((atomId) => state.activeCallByAtom[atomId] !== message.tool_call_id);
    if (inactive.length === 0 || typeof message.content !== 'string') return;
    replacements.set(index, {
      ...message,
      content: filterToolResultContent(message.content, new Set(inactive)),
    });
  });
  if (replacements.size === 0) return { request, candidates };
  const messages = request.messages.map((message, index) => replacements.get(index) ?? message);
  return {
    request: { ...request, messages },
    candidates: candidates?.map((candidate) => ({
      ...candidate,
      message: replacements.get(candidate.order) ?? candidate.message,
      segments: candidate.segments?.map((segment) => {
        if (segment.source.kind !== 'memory' || segment.source.id !== 'initial-selection') return segment;
        const inactive = (state.callAtomIds.initial ?? [])
          .filter((atomId) => state.activeCallByAtom[atomId] !== 'initial');
        return inactive.length > 0
          ? { ...segment, text: filterRenderedMemory(segment.text, new Set(inactive)) }
          : segment;
      }),
    })),
  };
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
  const retained: string[] = [];
  let suppress = false;
  let removed = 0;
  for (const line of lines) {
    const headingEnd = line.startsWith('## [') ? line.indexOf(']', 4) : -1;
    if (headingEnd > 4) {
      suppress = inactiveAtomIds.has(line.slice(4, headingEnd));
      if (suppress) removed += 1;
    } else if (line === '# Child Index') {
      suppress = false;
    }
    if (!suppress) retained.push(line);
  }
  if (removed > 0) retained.push('', `[${removed} memory atom section(s) released from the active run context.]`);
  return retained.join('\n');
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
