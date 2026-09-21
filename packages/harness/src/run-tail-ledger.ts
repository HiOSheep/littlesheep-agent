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
import { renderKnownStateText, knownStateRulesSection } from './memory-known-state.js';
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
  /** The entries those messages were rendered from, in the same order. */
  entries: RunTailEntry[];
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

  /**
   * Append every tail entry that has not been sent yet in this loop.
   *
   * `systemSegments` are the sections the system message is made of, and
   * `tailSegments` are the bundle's below-boundary sections. Both are needed:
   * a section marked below the boundary must be emitted here, as its own
   * message, or it would be lost — folding it into the system message is what
   * used to move it above the boundary.
   */
  update(
    ctx: RunContext,
    systemSegments: readonly ContextMessageSegment[] = [],
    tailSegments: readonly ContextMessageSegment[] = [],
  ): RunTailDelta {
    const messages: ChatMessage[] = [];
    const entries: RunTailEntry[] = [];
    for (const entry of renderTailEntries(ctx, systemSegments, tailSegments)) {
      const fingerprint = `${entry.id}#${hash(entry.text)}`;
      if (this.sent.has(fingerprint)) continue;
      this.sent.add(fingerprint);
      messages.push({ role: 'system', content: entry.text });
      entries.push(entry);
    }
    return { messages, entries };
  }
}

/** The current tail projection of the run, in the order the model must read it. */
export function renderTailEntries(
  ctx: RunContext,
  systemSegments: readonly ContextMessageSegment[] = [],
  tailSegments: readonly ContextMessageSegment[] = [],
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
  // Sections the prompt placed below the cache boundary, in the order the prompt
  // rendered them. The retrieval contract is one of these; so are the output
  // directives, the workspace bootstrap files and the run/runtime disclosure.
  const belowBoundary = [
    ...tailSegments,
    ...systemSegments.filter(isTailOwnedSegment),
  ];
  for (const [index, segment] of belowBoundary.entries()) {
    entries.push({
      id: segment.id,
      order: 0.5 + index,
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
  // The KnownState reading rules are interval policy, not run state: they are
  // byte-identical in every entry, so they travel once in this stable slot
  // instead of being repeated inside each (frequently re-sent) memory entry.
  // They carry no boundary marker: their position in the append-only tail is
  // what places them below the boundary, and the marker is for a section whose
  // *content* would otherwise be read as part of the stable prompt.
  entries.push({
    id: 'memory-known-state-rules',
    order: 2.5,
    text: knownStateRulesSection(),
    kind: 'memory_fragment',
    source: { kind: 'memory', id: 'known-state-rules', runId: ctx.runId },
    scope: 'run',
  });
  const knownState = ctx.memoryKnownState;
  if (knownState && knownState.references.length > 0) {
    entries.push({
      id: 'memory-known-state',
      order: 3,
      text: renderKnownStateText(knownState, { includeRules: false }),
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
