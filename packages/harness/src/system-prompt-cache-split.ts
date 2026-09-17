// Keep only the session-stable system-prompt sections in the system message.
//
// The Provider matches its prefix cache from token zero, so any per-request
// change *inside* the system prompt caps reuse at that byte and every later
// token — including the whole conversation — is re-billed. Every section below
// the cache boundary therefore travels as its own trailing Context message,
// preserving the Context kind the contract already validated.
import type { ContextMessageSegment } from '@littlesheep/context';
import { CACHE_BOUNDARY_MARKER, type SystemPromptBundle } from '@littlesheep/prompt';

export interface SystemPromptCacheSplit {
  /** Byte-stable system message text: the sections above the boundary. */
  systemText: string;
  /** Volatile sections, in order, carrying their original Context kind. */
  trailingSegments: ContextMessageSegment[];
}

export function splitSystemPromptForCache(bundle: SystemPromptBundle): SystemPromptCacheSplit {
  const stable: string[] = [];
  const trailingSegments: ContextMessageSegment[] = [];
  let boundarySeen = false;
  for (const [index, segment] of bundle.segments.entries()) {
    const markerIndex = boundarySeen ? -1 : segment.text.indexOf(CACHE_BOUNDARY_MARKER);
    if (!boundarySeen && markerIndex < 0) {
      stable.push(segment.text);
      continue;
    }
    boundarySeen = true;
    if (markerIndex >= 0) {
      const stableTail = segment.text.slice(0, markerIndex).replace(/\s+$/u, '');
      if (stableTail) stable.push(stableTail);
    }
    trailingSegments.push({
      id: segment.id,
      order: bundle.segments.length + index,
      text: markerIndex < 0
        ? segment.text
        : segment.text.slice(markerIndex + CACHE_BOUNDARY_MARKER.length).replace(/^[\s-]+/u, ''),
      kind: segment.kind,
      source: segment.source,
      priority: segment.priority,
      required: segment.required,
      sensitive: segment.sensitive,
      scope: segment.scope,
    });
  }
  return { systemText: stable.join(''), trailingSegments };
}
