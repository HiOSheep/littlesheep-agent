// Turn one outbound stage request into explicit, source-aware Context candidates.
//
// The assembler's job is to describe *where every message came from* (prompt,
// session history, tool result, workflow state) and how firmly it may be changed:
// the call contract validates Context by kind, budgeting evicts by priority, and
// everything the caller already sent must keep its exact position. Sections the
// prompt marks `placement: 'trailing'` are emitted once, beside the conversation,
// instead of being folded back into the system message.
import type { ContextMessageCandidate, ContextMessageSegment } from '@littlesheep/context';
import type {
  ContextItemKind,
  ContextScope,
  ContextSourceRef,
  Message,
  RunContext,
  StageName,
} from '@littlesheep/types';
import { filterAuthoritativeUserFacingMessages } from '@littlesheep/types';
import type { ChatMessage } from '@littlesheep/llm';

/** Context sections whose text changes every turn because the task book advances. */
const VOLATILE_GUIDANCE_SEGMENT_IDS = new Set([
  'execution-plan',
  'retrieval-intent-contract',
  'explicit-tool-proposal-contract',
]);

export interface BuildRunRequestCandidatesOptions {
  history?: Message[];
  primaryUserKind?: ContextItemKind;
  systemSegments?: ContextMessageSegment[];
  insertedBeforePrimary?: InsertedContextMessage[];
  /**
   * Volatile Context sections appended after the conversation so they cannot
   * break the Provider's cacheable prefix. Their Context kind is preserved.
   */
  trailingSegments?: ContextMessageSegment[];
  /**
   * Who emits the trailing sections.
   *
   * `context` (default) lets this assembler append them, which is what a
   * single-request stage wants. `caller` means the caller owns an append-only
   * tail and has already appended these sections as messages: this assembler
   * must then not append them a second time at a new position, or the previous
   * request would stop being a prefix of the next one.
   */
  trailingOwnership?: 'context' | 'caller';
  /**
   * Which message is the request's own user turn.
   *
   * Defaults to the position this assembler computes from history plus inserted
   * messages. A caller that appends feedback to an already-assembled request
   * names it explicitly, so the appended turn is described as the user input
   * rather than as a workflow or constraint message.
   */
  primaryUserIndex?: number;
  /**
   * Messages the caller's append-only tail owns. They keep their
   * `runtime_event` Context kind here rather than being described as workflow
   * state, and their position is their index, so nothing about the ordering
   * changes.
   */
  tailMessages?: ReadonlySet<ChatMessage>;
  /**
   * The declared Context kind of a tail message, when the caller knows it. Each
   * below-boundary prompt section already declares its own kind; without it the
   * section would be counted as a runtime event and its accounting would be
   * wrong even though its bytes were right.
   */
  tailKinds?: ReadonlyMap<ChatMessage, {
    kind: ContextItemKind;
    source: ContextSourceRef;
    scope?: ContextScope;
  }>;
}

export interface InsertedContextMessage {
  id: string;
  kind: ContextItemKind;
  source: ContextSourceRef;
  priority: number;
  required: boolean;
  sensitive?: boolean;
  scope?: ContextScope;
}

/**
 * Context sections the caller's append-only tail owns.
 *
 * A section marked `placement: 'trailing'` by the prompt builder is emitted by
 * the tail owner exactly once; folding it into the system message here would
 * make it re-appear at a new position on every request.
 */
export function isTailOwnedSegment(segment: ContextMessageSegment): boolean {
  return segment.placement === 'trailing';
}

/** Map an outbound stage request to explicit Context sources without retaining duplicate content. */
export function buildRunRequestCandidates(
  ctx: RunContext,
  stage: StageName,
  messages: ChatMessage[],
  options: BuildRunRequestCandidatesOptions = {},
): ContextMessageCandidate[] {
  // Callers may provide a history slice assembled outside buildRunContext
  // (for example during recovery or a direct stage test). Enforce the same
  // publication boundary here so an unconfirmed FINALIZE proposal can never
  // become a model candidate merely by bypassing the normal context builder.
  const history = filterAuthoritativeUserFacingMessages(options.history ?? ctx.history);
  const historyPriorities = conversationContinuityPriorities(history, ctx.inbound);
  const historyEvictionGroups = conversationTurnEvictionGroups(history, stage);
  const inserted = options.insertedBeforePrimary ?? [];
  const insertedStartIndex = 1 + history.length;
  const primaryUserIndex = options.primaryUserIndex
    ?? insertedStartIndex + inserted.length;
  const primaryUserKind = options.primaryUserKind ?? 'user_input';
  const callerOwnsTail = options.trailingOwnership === 'caller';
  const emitTrailing = (segment: ContextMessageSegment): boolean => (
    !callerOwnsTail && !isTailOwnedSegment(segment)
  );

  // Task guidance changes on every turn (the task book advances), so keeping it
  // inside the system message would truncate the Provider's cached prefix for
  // the whole conversation. It travels as a trailing Context section instead.
  //
  // Every other section the caller marks as below the boundary travels the same
  // way. When the caller owns the tail it has already appended them, so this
  // assembler emits none of them; when it does not, they are emitted here in
  // the order the caller listed them. What this assembler must never do is fold
  // them back into the system message: that put below-boundary sections above
  // the boundary, and any request built on the result no longer repeated the
  // prompt's own bytes.
  const allSegments = options.systemSegments ?? [];
  const trailingAddons = allSegments.filter((segment) => (
    isTailOwnedSegment(segment) || VOLATILE_GUIDANCE_SEGMENT_IDS.has(segment.id)
  ));
  const remainingSegments = trailingAddons.length === 0
    ? allSegments
    : allSegments.filter((segment) => !trailingAddons.includes(segment));
  // The system candidate always carries source-aware segments: the call
  // contract validates Context by kind, and a caller that passes a prebuilt
  // system message (a direct stage test, recovery, or a hand-assembled request)
  // would otherwise present no `system_prompt` kind at all.
  const systemSegments = remainingSegments.length > 0
    ? remainingSegments
    : [singleSystemSegment(stage, messages[0])];
  const emittedTrailing = trailingAddons.filter(emitTrailing);
  const systemFromSegments = systemSegments.map((segment) => segment.text).join('');
  const firstMessage = messages[0] as ChatMessage | undefined;
  // Rebuild the system message from its remaining segments only when a section
  // really left it; otherwise keep the caller's bytes untouched.
  const systemMessage = firstMessage?.role !== 'system' || systemFromSegments === firstMessage.content
    ? undefined
    : { ...firstMessage, content: systemFromSegments };

  const mapped = messages.flatMap((message, index) => {
    const order = index;
    // Tail messages keep their position and, when the caller can name it, the
    // Context kind the prompt declared for that section: a bootstrap file is
    // project knowledge and the memory index is a memory index whether it
    // travels inside the system message or as its own message.
    if (options.tailMessages?.has(message)) {
      const declared = options.tailKinds?.get(message);
      return [candidate({
        id: `${stage}:tail:${index}`,
        order,
        message,
        kind: declared?.kind ?? 'runtime_event',
        source: declared?.source ?? { kind: 'runtime_event', id: `${stage}:tail:${index}`, runId: ctx.runId },
        priority: 100,
        required: true,
        scope: declared?.scope ?? 'run',
      })];
    }
    if (index === 0 && message.role === 'system') {
      return [candidate({
        id: `${stage}:system`,
        order,
        message: systemMessage ?? message,
        kind: 'system_prompt',
        source: { kind: 'prompt', id: `${stage}:system` },
        priority: 100,
        required: true,
        segments: systemSegments,
      })];
    }

    const historyMessage = index > 0 && index <= history.length
      ? history[index - 1]
      : undefined;
    if (historyMessage) {
      return [candidate({
        id: `${stage}:history:${historyMessage.id}`,
        order,
        message,
        kind: 'recent_message',
        source: {
          kind: 'message',
          id: historyMessage.id,
          sessionId: ctx.sessionId,
          generatedAt: historyMessage.timestamp,
        },
        priority: historyPriorities[index - 1] ?? 75,
        required: false,
        evictionGroup: historyEvictionGroups[index - 1],
      })];
    }

    const insertedMessage = index >= insertedStartIndex && index < primaryUserIndex
      ? inserted[index - insertedStartIndex]
      : undefined;
    if (insertedMessage) {
      return [candidate({
        id: `${stage}:inserted:${insertedMessage.id}`,
        order,
        message,
        kind: insertedMessage.kind,
        source: insertedMessage.source,
        priority: insertedMessage.priority,
        required: insertedMessage.required,
        sensitive: insertedMessage.sensitive ?? true,
        scope: insertedMessage.scope,
      })];
    }

    if (index === primaryUserIndex && message.role === 'user') {
      const sourceKind = primaryUserKind === 'workflow_state' ? 'workflow' : 'message';
      return [candidate({
        id: `${stage}:primary-user:${ctx.inbound.id}`,
        order,
        message,
        kind: primaryUserKind,
        source: {
          kind: sourceKind,
          id: primaryUserKind === 'workflow_state' ? `${stage}:workflow-input` : ctx.inbound.id,
          sessionId: ctx.sessionId,
          generatedAt: ctx.inbound.timestamp,
        },
        priority: primaryUserKind === 'user_input' ? 95 : 85,
        required: true,
      })];
    }

    if (message.role === 'tool') {
      return [candidate({
        id: `${stage}:tool:${message.tool_call_id ?? 'unknown'}:${index}`,
        order,
        message,
        kind: 'tool_result',
        source: { kind: 'tool', id: message.tool_call_id ?? `${stage}:tool:${index}`, runId: ctx.runId },
        priority: 90,
        required: true,
      })];
    }

    if ((message.tool_calls?.length ?? 0) > 0) {
      return [candidate({
        id: `${stage}:tool-proposal:${message.tool_calls!.map((call) => call.id).join(',')}:${index}`,
        order,
        message,
        kind: 'workflow_state',
        source: { kind: 'workflow', id: `${stage}:tool-proposal`, runId: ctx.runId },
        priority: 90,
        required: true,
      })];
    }

    if (message.role === 'user') {
      return [candidate({
        id: `${stage}:constraint:${index}`,
        order,
        message,
        kind: 'output_constraint',
        source: { kind: 'workflow', id: `${stage}:constraint:${index}`, runId: ctx.runId },
        priority: 90,
        required: true,
      })];
    }

    return [candidate({
      id: `${stage}:workflow:${index}`,
      order,
      message,
      kind: 'workflow_state',
      source: { kind: 'workflow', id: `${stage}:workflow:${index}`, runId: ctx.runId },
      priority: 80,
      required: true,
    })];
  });
  // One section, one candidate. A caller may hand over its own trailing
  // segments while also passing the full segment list; a section that is in both
  // would otherwise become a duplicate candidate id and be rejected as a
  // contract violation. The full list already carries that section below the
  // boundary, so the extra copy is dropped rather than the request failing.
  const knownSectionIds = new Set(allSegments.map((segment) => segment.id));
  const extraTrailing = (options.trailingSegments ?? []).filter((segment) => (
    emitTrailing(segment) && !knownSectionIds.has(segment.id)
  ));
  const trailing = [...emittedTrailing, ...extraTrailing].map((segment, index) => candidate({
    id: segment.id,
    order: messages.length + index,
    message: { role: 'system', content: segment.text },
    kind: segment.kind,
    source: segment.source,
    priority: segment.priority,
    required: segment.required,
    sensitive: segment.sensitive ?? true,
    scope: segment.scope,
  }));
  return trailing.length === 0 ? mapped : [...mapped, ...trailing];
}

function candidate(
  value: Omit<ContextMessageCandidate, 'sensitive'> & { sensitive?: boolean },
): ContextMessageCandidate {
  return { ...value, sensitive: value.sensitive ?? true };
}

/**
 * The one segment of a system message the caller assembled itself.
 *
 * Its text is the whole message, so the segmented candidate still matches its
 * own content and the call contract sees a `system_prompt` source.
 */
function singleSystemSegment(
  stage: StageName,
  message: ChatMessage | undefined,
): ContextMessageSegment {
  return {
    id: `${stage}:system:text`,
    order: 0,
    text: typeof message?.content === 'string' ? message.content : '',
    kind: 'system_prompt',
    source: { kind: 'prompt', id: `${stage}:system` },
    priority: 100,
    required: true,
    sensitive: true,
    scope: 'global',
  };
}

function conversationContinuityPriorities(history: Message[], inbound: Message): number[] {
  const inboundTerms = continuityTerms(messageText(inbound));
  const priorities: number[] = history.map((message, index) => {
    const distanceFromLatest = history.length - 1 - index;
    const recencyPriority = distanceFromLatest < 4
      ? 90
      : distanceFromLatest < 8
        ? 82
        : 72;
    return sharesContinuityTerm(inboundTerms, continuityTerms(messageText(message)))
      ? 94
      : recencyPriority;
  });

  // Keep a user/assistant turn coherent when only one side repeats the active
  // entity. A retained answer without its subject is not useful continuity.
  for (let index = 0; index < history.length - 1; index += 1) {
    if (history[index]?.role !== 'user' || history[index + 1]?.role !== 'assistant') continue;
    const turnPriority = Math.max(priorities[index] ?? 72, priorities[index + 1] ?? 72);
    priorities[index] = turnPriority;
    priorities[index + 1] = turnPriority;
  }
  return priorities;
}

function messageText(message: Message): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function continuityTerms(value: string): Set<string> {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('en-US');
  const terms = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9]+(?:[-_.:/][a-z0-9]+)*/gu)) {
    const identifier = match[0];
    if (identifier.length >= 2) terms.add(identifier);
    for (const part of identifier.split(/[-_.:/]+/u)) {
      if (part.length >= 2) terms.add(part);
    }
  }
  for (const match of normalized.matchAll(/[\u3400-\u9fff]{3,}/gu)) {
    const run = match[0];
    for (let index = 0; index <= run.length - 3; index += 1) {
      const term = run.slice(index, index + 3);
      if (!GENERIC_CONTINUITY_TERMS.has(term)) terms.add(term);
    }
  }
  return terms;
}

function sharesContinuityTerm(left: Set<string>, right: Set<string>): boolean {
  for (const term of left) {
    if (right.has(term)) return true;
  }
  return false;
}

function conversationTurnEvictionGroups(history: Message[], stage: StageName): Array<string | undefined> {
  const groups: Array<string | undefined> = history.map(() => undefined);
  for (let index = 0; index < history.length - 1; index += 1) {
    if (history[index]?.role !== 'user' || history[index + 1]?.role !== 'assistant') continue;
    const group = `${stage}:history-turn:${history[index]?.id ?? index}`;
    groups[index] = group;
    groups[index + 1] = group;
  }
  return groups;
}

const GENERIC_CONTINUITY_TERMS = new Set([
  '介绍一', '绍一下', '是什么', '为什么', '怎么样', '怎么做', '可以吗', '需要吗', '能不能',
]);
