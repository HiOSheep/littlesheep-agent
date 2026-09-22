// The task-interval transcript the model replays.
//
// A Provider prefix cache only matches from token zero, so the first request of a
// turn has to *extend* the previous turn's requests byte for byte. Rebuilding the
// history from prose alone broke that: on the frozen real long tasks every turn's
// first request re-billed 1.1k-1.7k tokens because the assistant tool calls and
// their results had been dropped, and the rebuilt prompt was *shorter* than the
// one before it (A1: turn 2 -516, turn 3 -1015 prompt tokens).
//
// This module replays the persisted session messages instead: assistant tool calls
// with the exact argument string the Provider produced, paired with the exact tool
// result text the model saw. Only complete call groups are replayed — a Provider
// rejects a tool message whose call is missing, so an orphan result is dropped
// rather than sent. The oldest messages are dropped only at group boundaries and
// only past the documented safety ceiling; `sessions.compaction` is the real bound.
import type { ChatMessage } from '@littlesheep/llm';
import type { Message, RunContext } from '@littlesheep/types';
import { conversationHistoryForModel, toChatMessage } from './stages/_shared.js';
import { toolResultForModel } from './stages/execute/tool-result-persistence.js';

/**
 * Safety ceiling for the replayed transcript. It is deliberately far above any
 * measured task interval: compaction (`sessions.compaction.threshold/keepRecent`)
 * is the bound that decides what a run receives, and this ceiling only prevents a
 * pathological session from producing an unbounded request.
 */
export const MODEL_HISTORY_MAX_CHARS = 96_000;

interface PendingCall {
  id: string;
  name: string;
  arguments: string;
}

function messageText(message: Message): string {
  return message.content
    .filter((part): part is Extract<Message['content'][number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function chatRole(message: Message): ChatMessage['role'] {
  return message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user';
}

function groupChars(group: ChatMessage[]): number {
  return group.reduce((total, message) => total + JSON.stringify(message).length, 0);
}

/** Drop the oldest groups until the ceiling is met; never split a call group. */
function boundGroups(groups: ChatMessage[][], maxChars: number): ChatMessage[] {
  let total = groups.reduce((sum, group) => sum + groupChars(group), 0);
  let start = 0;
  while (start < groups.length - 1 && total > maxChars) {
    total -= groupChars(groups[start]!);
    start += 1;
  }
  return groups.slice(start).flat();
}

/**
 * Convert persisted session messages into the chat messages the Provider saw.
 * Reasoning is not replayed (it is metadata, not prompt text), and incomplete or
 * orphaned tool groups are dropped so the request stays valid.
 */
export function projectModelHistory(
  messages: readonly Message[],
  maxChars = MODEL_HISTORY_MAX_CHARS,
): ChatMessage[] {
  const groups: ChatMessage[][] = [];
  let pending: {
    text: string;
    reasoning?: string;
    calls: PendingCall[];
    results: Map<string, ChatMessage>;
  } | undefined;

  const flush = (): void => {
    if (!pending) return;
    const { text, reasoning, calls, results } = pending;
    pending = undefined;
    if (calls.length === 0 || calls.some((call) => !results.has(call.id))) return;
    const group: ChatMessage[] = [{
      role: 'assistant',
      content: text,
      // The request echoes the Provider's own reasoning for this turn, so the
      // replayed message carries it too.
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    }];
    for (const call of calls) group.push(results.get(call.id)!);
    groups.push(group);
  };

  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'tool_calls') {
        flush();
        pending = {
          text: messageText(message),
          reasoning: message.content.find((block) => block.type === 'reasoning')?.text,
          calls: part.calls.map((call) => ({
            id: call.id,
            name: call.name,
            // The Provider's own argument string when it could be persisted, so
            // the replayed bytes match the cached ones.
            arguments: call.rawArguments ?? JSON.stringify(call.input ?? {}),
          })),
          results: new Map(),
        };
        continue;
      }
      if (part.type === 'tool_result') {
        const chat: ChatMessage = {
          role: 'tool',
          tool_call_id: part.result.callId,
          content: part.modelContent ?? toolResultForModel(part.result),
        };
        if (pending?.calls.some((call) => call.id === part.result.callId)) {
          pending.results.set(part.result.callId, chat);
        }
        continue;
      }
      if (part.type !== 'text') continue;
      if (!part.text.trim()) continue;
      flush();
      groups.push([{ role: chatRole(message), content: part.text }]);
    }
  }
  flush();
  return boundGroups(groups, maxChars);
}

/**
 * The history a request should carry: the task-interval replay when the run has
 * one, otherwise the prose projection this stage used before (a context built by
 * a test or a replay path).
 */
export function modelHistoryMessages(ctx: Pick<RunContext, 'history' | 'modelHistory'>): ChatMessage[] {
  if (ctx.modelHistory && ctx.modelHistory.length > 0) return projectModelHistory(ctx.modelHistory);
  return conversationHistoryForModel(ctx).map(toChatMessage);
}
