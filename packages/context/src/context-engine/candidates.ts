import type { ChatMessage } from '@littlesheep/llm';
import type { ContextItemKind } from '@littlesheep/types';
import type { ContextMessageCandidate } from './contracts.js';

export function inferCandidates(messages: ChatMessage[]): ContextMessageCandidate[] {
  // A trailing Runtime/Provider message may follow the user turn, so identify
  // the user input by role rather than by array position.
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  return messages.map((message, index) => {
    const kind = contextKind(message, index, lastUserIndex);
    const participatesInToolSequence = message.role === 'tool' || (message.tool_calls?.length ?? 0) > 0;
    return {
      id: `message-${index}`,
      order: index,
      message,
      kind,
      source: {
        kind: message.role === 'system'
          ? 'prompt'
          : message.role === 'tool'
            ? 'tool'
            : 'message',
        id: message.tool_call_id ?? `message-${index}`,
      },
      priority: kind === 'system_prompt'
        ? 100
        : kind === 'user_input'
          ? 90
          : participatesInToolSequence
            ? 85
            : 50,
      required: kind === 'system_prompt' || kind === 'user_input' || participatesInToolSequence,
      sensitive: true,
    };
  });
}

export function normalizeCandidates(candidates: ContextMessageCandidate[]): ContextMessageCandidate[] {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) throw new Error(`Duplicate context candidate id: ${candidate.id}`);
    ids.add(candidate.id);
    if (!candidate.segments) continue;
    if (typeof candidate.message.content !== 'string') {
      throw new Error(`Segmented context candidate ${candidate.id} must use text content.`);
    }
    const assembled = candidate.segments.map((segment) => segment.text).join('');
    if (assembled !== candidate.message.content) {
      throw new Error(`Segmented context candidate ${candidate.id} does not match its message content.`);
    }
    for (const segment of candidate.segments) {
      if (ids.has(segment.id)) throw new Error(`Duplicate context candidate id: ${segment.id}`);
      ids.add(segment.id);
    }
  }
  return [...candidates].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function contextKind(message: ChatMessage, index: number, lastUserIndex: number): ContextItemKind {
  if (message.role === 'system') return 'system_prompt';
  if (message.role === 'tool') return 'tool_result';
  if (message.role === 'user' && index === lastUserIndex) return 'user_input';
  return 'recent_message';
}
