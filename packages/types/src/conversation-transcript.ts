import type { ConversationTranscriptEntry, ToolStreamEvent } from './activity.js';

/** Bounded display record. Retries retain partial prose with an explicit aborted state. */
export function reduceConversationTranscript(
  entries: readonly ConversationTranscriptEntry[],
  event: ToolStreamEvent,
): ConversationTranscriptEntry[] {
  let next = [...entries];
  if (event.type === 'tool_start' && event.callId) {
    if (!next.some((entry) => entry.kind === 'tool' && entry.callId === event.callId)) {
      next.push({ kind: 'tool', id: `tool:${event.callId}`, callId: event.callId });
    }
  } else if (event.type === 'model_text' && event.phaseId) {
    const ref = event.streamRef;
    const prefix = ref ? `${ref.runId}:${ref.requestId}:` : '';
    const id = `${prefix}${ref ? `${ref.transportAttempt}:` : ''}${event.phaseId}:text`;
    if (ref?.operation === 'reset') {
      next = next.map((entry) => entry.kind === 'text' && entry.id.startsWith(prefix) && entry.status === 'running'
        ? { ...entry, status: 'aborted' } : entry);
    } else {
      const previous = next.find((entry) => entry.id === id);
      const text = ref?.operation === 'append' && previous?.kind === 'text'
        ? previous.text + (event.summary ?? '') : event.summary ?? '';
      if (text) {
        const entry: ConversationTranscriptEntry = { kind: 'text', id, text: text.slice(0, 16_000), status: event.reasoningStatus ?? 'done' };
        next = previous ? next.map((item) => item.id === id ? entry : item) : [...next, entry];
      }
    }
  }
  return next.slice(-256);
}
