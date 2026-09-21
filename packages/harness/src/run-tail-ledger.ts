// The main loop's append-only tail.
//
// Everything below the system-prompt cache boundary — Runtime capability facts,
// the per-turn retrieval contract, memory release notes and the Run Memory
// KnownState — used to be re-rendered and re-appended on every model request.
// The Provider's prefix cache matches from token zero, so a tail that moves to a
// new position on each iteration makes the previous request stop being a prefix
// of the next one and forfeits the cached conversation bytes.
//
// The tail is therefore a ledger: each entry is rendered, hashed and appended
// once; later iterations reuse the appended messages and only append entries
// whose content actually changed. A→B→A is two recorded transitions, not a
// rewind, because the earlier message is never rewritten.
import { createHash } from 'node:crypto';
import type { ContextMessageSegment } from '@littlesheep/context';
import type { ChatMessage } from '@littlesheep/llm';
import { CACHE_BOUNDARY_MARKER } from '@littlesheep/prompt';
import type {
  ContextItemKind,
  ContextScope,
  ContextSourceRef,
  RunContext,
} from '@littlesheep/types';
import { isTailOwnedSegment } from './context-candidates.js';
import {
  memoryReleaseNoteText,
  releasedAtomIdsFromWorkingSet,
} from './memory-context-working-set.js';
import { renderKnownStateText } from './memory-known-state.js';
import { renderRuntimeFacts, renderVolatileRunState } from './runtime-awareness.js';

export interface RunTailEntry {
  id: string;
  order: number;
  text: string;
  kind: ContextItemKind;
  source: ContextSourceRef;
  scope: ContextScope;
}

/** One iteration's tail additions. */
export interface RunTailDelta {
  messages: ChatMessage[];
}

/**
 * An append-only ledger of the tail entries this loop has already sent.
 *
 * The identity of an entry is its semantic id plus a content hash, so a changed
 * fact produces a new entry instead of rewriting an earlier one, and re-sending
 * an unchanged fact is impossible. A→B→A is therefore two recorded transitions,
 * not a rewind.
 */
export class RunTailLedger {
  private readonly sent = new Set<string>();

  /** Append every tail entry that has not been sent yet in this loop. */
  update(ctx: RunContext, systemSegments: readonly ContextMessageSegment[] = []): RunTailDelta {
    const messages: ChatMessage[] = [];
    for (const entry of renderTailEntries(ctx, systemSegments)) {
      const fingerprint = `${entry.id}#${hash(entry.text)}`;
      if (this.sent.has(fingerprint)) continue;
      this.sent.add(fingerprint);
      messages.push({ role: 'system', content: entry.text });
    }
    return { messages };
  }
}

/** The current tail projection of the run, in the order the model must read it. */
export function renderTailEntries(
  ctx: RunContext,
  systemSegments: readonly ContextMessageSegment[] = [],
): RunTailEntry[] {
  const entries: RunTailEntry[] = [];
  entries.push({
    id: 'runtime-facts',
    order: 0,
    text: renderRuntimeFacts(ctx),
    kind: 'runtime_event',
    source: {
      kind: 'runtime_event',
      id: 'runtime-facts',
      runId: ctx.runId,
      ...(ctx.startedAt ? { generatedAt: ctx.startedAt } : {}),
    },
    scope: 'run',
  });
  for (const segment of systemSegments) {
    if (!isTailOwnedSegment(segment)) continue;
    entries.push({
      id: segment.id,
      order: 0.5,
      text: segment.text,
      kind: segment.kind,
      source: segment.source,
      scope: segment.scope ?? 'run',
    });
  }
  const volatile = renderVolatileRunState(ctx);
  if (volatile) {
    entries.push({
      id: 'runtime-state',
      order: 1,
      text: `${CACHE_BOUNDARY_MARKER}\n\n${volatile}`,
      kind: 'runtime_event',
      source: { kind: 'runtime_event', id: 'runtime-state', runId: ctx.runId },
      scope: 'run',
    });
  }
  const releaseIds = releasedAtomIdsFromWorkingSet(ctx.memoryContextWorkingSet);
  if (releaseIds.length > 0) {
    entries.push({
      id: 'memory-release',
      order: 2,
      text: memoryReleaseNoteText(releaseIds),
      kind: 'memory_fragment',
      source: { kind: 'memory', id: `released-atoms:${releaseIds.join(',')}`, runId: ctx.runId },
      scope: 'run',
    });
  }
  const knownState = ctx.memoryKnownState;
  if (knownState && knownState.references.length > 0) {
    entries.push({
      id: 'memory-known-state',
      order: 3,
      text: renderKnownStateText(knownState),
      kind: 'memory_fragment',
      source: {
        kind: 'memory',
        id: `known-state:${ctx.runId}:${knownState.revision}`,
        runId: ctx.runId,
        generatedAt: knownState.updatedAt,
      },
      scope: 'run',
    });
  }
  return entries;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
