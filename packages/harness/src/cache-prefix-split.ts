// Which bytes of an outbound request form the cacheable head, and how a message
// is canonicalized before it is hashed.
//
// A Provider prefix cache matches from token zero, so the cacheable region is the
// LEADING system block: everything before the first conversation message.
// Each stable entry carries a position relative to that set, not its absolute
// request index, because an absolute index changes identity whenever it gains a
// digit even though every byte of the cacheable content is unchanged. Dynamic
// entries keep the absolute index -- their identity is allowed to move with the
// transcript.
import type { ChatMessage, ChatRequest } from '@littlesheep/llm';
import { CACHE_BOUNDARY_MARKER } from '@littlesheep/prompt';

export function normalizeText(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').normalize('NFC');
}

export function normalizeMessage(message: ChatMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: typeof message.content === 'string'
      ? normalizeText(message.content)
      : message.content.map((part) => part.type === 'text'
        ? { type: 'text', text: normalizeText(part.text) }
        : { type: 'image_url', image_url: {
            url: normalizeText(part.image_url.url),
            ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
          } }),
    ...(message.reasoning_content ? { reasoning_content: normalizeText(message.reasoning_content) } : {}),
    ...(message.tool_calls ? {
      tool_calls: message.tool_calls.map((call) => ({
        id: normalizeText(call.id),
        type: call.type,
        function: { name: normalizeText(call.function.name), arguments: normalizeText(call.function.arguments) },
      })),
    } : {}),
    ...(message.tool_call_id ? { tool_call_id: normalizeText(message.tool_call_id) } : {}),
    ...(message.name ? { name: normalizeText(message.name) } : {}),
  };
}

export function splitRequestForCache(request: ChatRequest): {
  stableMessages: unknown[];
  dynamicMessages: unknown[];
} {
  const stableMessages: unknown[] = [];
  const dynamicMessages: unknown[] = [];
  // A Provider cache matches from token zero, so the cacheable region is the
  // LEADING system block. Any system message that appears after conversation
  // content is per-turn state by construction -- the runtime appends the trailing
  // retrieval-intent and run-state sections after the primary user turn.
  //
  // Those trailing sections carry no boundary marker, so marker-only
  // classification put them in the stable set. Because the retrieval-intent
  // contract text changes whenever the turn's intent changes, the "stable" prefix
  // then changed identity on every such turn (measured: 40 distinct prefix
  // fingerprints across 40 requests of one session, and a 168-byte step matching
  // the contract's 83 -> 251 character variants). The bytes sent to the Provider
  // were unaffected -- the section sits last -- but the local stablePrefix and the
  // invalidation reasons derived from it reported a spurious prompt change on
  // nearly every request, which hid real invalidations.
  let seenConversationContent = false;
  request.messages.forEach((message, index) => {
    const normalized = normalizeMessage(message);
    // Stable entries carry a position relative to the stable set, not their
    // absolute index in the request: the absolute index grows with the
    // conversation, so embedding it made the "stable" prefix change identity
    // whenever an index gained a digit even though every byte of the cacheable
    // content was unchanged. The relative position still distinguishes repeated
    // identical messages. Dynamic entries keep the absolute index because their
    // identity is allowed to move with the transcript.
    const stableIndex = () => stableMessages.length;
    if (message.role !== 'system') {
      seenConversationContent = true;
      dynamicMessages.push({ index, message: normalized });
      return;
    }
    if (seenConversationContent) {
      // Trailing per-turn system section: never part of the cacheable head.
      dynamicMessages.push({ index, message: normalized });
      return;
    }
    if (typeof message.content !== 'string') {
      stableMessages.push({ index: stableIndex(), message: normalized });
      return;
    }
    const content = normalizeText(message.content);
    const markerIndex = content.indexOf(CACHE_BOUNDARY_MARKER);
    if (markerIndex < 0) {
      stableMessages.push({ index: stableIndex(), message: normalized });
      return;
    }
    const stableContent = content.slice(0, markerIndex).trimEnd();
    const dynamicContent = content.slice(markerIndex + CACHE_BOUNDARY_MARKER.length).trimStart();
    if (stableContent) stableMessages.push({ index: stableIndex(), role: message.role, content: stableContent });
    if (dynamicContent) dynamicMessages.push({ index, role: message.role, content: dynamicContent });
  });
  return { stableMessages, dynamicMessages };
}
