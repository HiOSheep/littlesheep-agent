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
