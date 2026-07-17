import type { ContextMessageCandidate, ContextMessageSegment } from '@littlesheep/context';
import type {
  ContextItemKind,
  ContextScope,
  ContextSourceRef,
  Message,
  RunContext,
  StageName,
} from '@littlesheep/types';
import type { ChatMessage } from '@littlesheep/llm';

export interface BuildRunRequestCandidatesOptions {
  history?: Message[];
  primaryUserKind?: ContextItemKind;
  systemSegments?: ContextMessageSegment[];
  insertedBeforePrimary?: InsertedContextMessage[];
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
  const history = options.history ?? ctx.history;
  const inserted = options.insertedBeforePrimary ?? [];
  const insertedStartIndex = 1 + history.length;
  const primaryUserIndex = insertedStartIndex + inserted.length;
  const primaryUserKind = options.primaryUserKind ?? 'user_input';

  return messages.map((message, index) => {
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
        // Recent conversation is more useful for continuity than the static date-time section;
        // runtime-awareness already carries the exact current clock and elapsed run facts.
        priority: 75,
        required: false,
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
}

function candidate(
  value: Omit<ContextMessageCandidate, 'sensitive'> & { sensitive?: boolean },
): ContextMessageCandidate {
  return { ...value, sensitive: value.sensitive ?? true };
}
