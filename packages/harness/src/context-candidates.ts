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
  const primaryUserIndex = insertedStartIndex + inserted.length;
  const primaryUserKind = options.primaryUserKind ?? 'user_input';

  const mapped = messages.map((message, index) => {
    if (index === 0 && message.role === 'system') {
      return candidate({
        id: `${stage}:system`,
        order: index,
        message,
        kind: 'system_prompt',
        source: { kind: 'prompt', id: `${stage}:system` },
        priority: 100,
        required: true,
        segments: options.systemSegments,
      });
    }

    const historyMessage = index > 0 && index <= history.length
      ? history[index - 1]
      : undefined;
    if (historyMessage) {
      return candidate({
        id: `${stage}:history:${historyMessage.id}`,
        order: index,
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
      });
    }

    const insertedMessage = index >= insertedStartIndex && index < primaryUserIndex
      ? inserted[index - insertedStartIndex]
      : undefined;
    if (insertedMessage) {
      return candidate({
        id: `${stage}:inserted:${insertedMessage.id}`,
        order: index,
        message,
        kind: insertedMessage.kind,
        source: insertedMessage.source,
        priority: insertedMessage.priority,
        required: insertedMessage.required,
        sensitive: insertedMessage.sensitive ?? true,
        scope: insertedMessage.scope,
      });
    }

    if (index === primaryUserIndex && message.role === 'user') {
      const sourceKind = primaryUserKind === 'workflow_state' ? 'workflow' : 'message';
      return candidate({
        id: `${stage}:primary-user:${ctx.inbound.id}`,
        order: index,
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
      });
    }

    if (message.role === 'tool') {
      return candidate({
        id: `${stage}:tool:${message.tool_call_id ?? 'unknown'}:${index}`,
        order: index,
        message,
        kind: 'tool_result',
        source: { kind: 'tool', id: message.tool_call_id ?? `${stage}:tool:${index}`, runId: ctx.runId },
        priority: 90,
        required: true,
      });
    }

    if ((message.tool_calls?.length ?? 0) > 0) {
      return candidate({
        id: `${stage}:tool-proposal:${message.tool_calls!.map((call) => call.id).join(',')}:${index}`,
        order: index,
        message,
        kind: 'workflow_state',
        source: { kind: 'workflow', id: `${stage}:tool-proposal`, runId: ctx.runId },
        priority: 90,
        required: true,
      });
    }

    if (message.role === 'user') {
      return candidate({
        id: `${stage}:constraint:${index}`,
        order: index,
        message,
        kind: 'output_constraint',
        source: { kind: 'workflow', id: `${stage}:constraint:${index}`, runId: ctx.runId },
        priority: 90,
        required: true,
      });
    }

    return candidate({
      id: `${stage}:workflow:${index}`,
      order: index,
      message,
      kind: 'workflow_state',
      source: { kind: 'workflow', id: `${stage}:workflow:${index}`, runId: ctx.runId },
      priority: 80,
      required: true,
    });
  });
  const trailing = (options.trailingSegments ?? []).map((segment, index) => candidate({
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
