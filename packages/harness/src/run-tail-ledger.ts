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
// rewind, because the earlier message is never rewritten. "Changed" is measured
// against the value announced last, so A→B→A→B ends by announcing B again: the
// model reads the state that is in effect, not the state it saw most often.
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
import {
  RUNTIME_CONTEXT_TAIL_ID,
  renderRuntimeContextNotice,
} from './runtime-context-notice.js';

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
 * fact produces a new entry instead of rewriting an earlier one. The comparison
 * is against **the value last sent for that id**, never against the set of values
 * ever sent: a state that flips A→B→A→B must announce its final B even though a
 * B was announced earlier in the run, or the model keeps reading a stale
 * environment while the Runtime has already moved on. A→B→A is therefore two
 * recorded transitions, not a rewind, and a steady state still appends nothing.
 */
export class RunTailLedger {
  /** id → fingerprint of the last value this ledger announced for that id. */
  private readonly lastSent = new Map<string, string>();

  /**
   * Seed the ledger with entries an earlier run already sent in this task
   * interval, so a new run appends only facts that are new or changed.
   *
   * Without the seed every run re-emitted the whole tail: measured on frozen A1,
   * turn 2 repeated 9 of turn 1's 10 sections byte for byte (~1.2k tokens) even
   * though they were already in the replayed prefix, and the duplicate copies were
   * billed as new input.
   *
   * The entries arrive in transcript order, so the **last** one recorded for an id
   * is the value the model was last told — which is what the next comparison must
   * use. (A transcript that ends with A→B→A hands over A, not B.)
   */
  constructor(priorEntries: readonly { id: string; text: string }[] = []) {
    for (const entry of priorEntries) {
      this.lastSent.set(entry.id, `${entry.id}#${hash(entry.text)}`);
    }
  }

  /**
   * Append every tail entry whose current value differs from the last one this
   * loop announced for the same id.
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
      if (this.lastSent.get(entry.id) === fingerprint) continue;
      this.lastSent.set(entry.id, fingerprint);
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
  // The current execution environment, appended only when the effective state
  // moved. It sits directly after the capability facts so the model reads "what
  // this run can do" and "what this run is actually routed to" together. An
  // unchanged environment renders nothing, which is why the same state is never
  // announced twice.
  const runtimeContext = renderRuntimeContextNotice(ctx);
  if (runtimeContext) {
    entries.push({
      id: RUNTIME_CONTEXT_TAIL_ID,
      order: 0.25,
      text: runtimeContext,
      kind: 'runtime_event',
      source: { kind: 'runtime_event', id: RUNTIME_CONTEXT_TAIL_ID, runId: ctx.runId },
      scope: 'run',
    });
  }
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

/**
 * Insert one delta's tail messages right after the primary user turn and return the
 * Context kind each message declares, so a bootstrap file stays project knowledge
 * and the memory index stays a memory index.
 *
 * The position matters as much as the content: the tail belongs immediately after
 * the user turn, and appending it at the end of the request instead put it after
 * the first tool round for later iterations.
 */
export function spliceTailMessages(
  messages: ChatMessage[],
  delta: RunTailDelta,
): Map<ChatMessage, { kind: ContextItemKind; source: ContextSourceRef }> {
  const kinds = new Map<ChatMessage, { kind: ContextItemKind; source: ContextSourceRef }>();
  for (const [index, message] of delta.messages.entries()) {
    const declared = delta.entries[index];
    if (declared) kinds.set(message, { kind: declared.kind, source: declared.source });
  }
  let primaryUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      primaryUserIndex = index;
      break;
    }
  }
  messages.splice(primaryUserIndex < 0 ? messages.length : primaryUserIndex + 1, 0, ...delta.messages);
  return kinds;
}

/**
 * The tail entries an earlier run of this task interval already sent, read from
 * the replayed transcript. Seeding the ledger with them keeps an unchanged fact
 * from being appended (and billed) a second time.
 */
export function priorTailEntries(ctx: Pick<RunContext, 'modelHistory'>): { id: string; text: string }[] {
  const entries: { id: string; text: string }[] = [];
  for (const message of ctx.modelHistory ?? []) {
    if (message.runtimeTail !== true || !message.runtimeTailId) continue;
    const text = message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('');
    if (text) entries.push({ id: message.runtimeTailId, text });
  }
  return entries;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
