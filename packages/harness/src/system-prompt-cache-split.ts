// Keep only the session-stable system-prompt sections in the system message.
//
// The Provider matches its prefix cache from token zero, so any per-request
// change *inside* the system prompt caps reuse at that byte and every later
// token — including the whole conversation — is re-billed. Every section below
// the cache boundary therefore travels as its own trailing Context message,
// preserving the Context kind the contract already validated.
import { CACHE_BOUNDARY_MARKER } from '@littlesheep/prompt';
import type { ContextItemKind, ContextScope, ContextSourceRef } from '@littlesheep/types';

/**
 * A rendered system-prompt section. Kept structural so both the prompt
 * package's bundle segments and the Context engine's message segments fit.
 */
export interface CacheSplitSegment {
  id: string;
  order: number;
  text: string;
  kind: ContextItemKind;
  source: ContextSourceRef;
  priority: number;
  required: boolean;
  sensitive: boolean;
  scope?: ContextScope;
  evictionGroup?: string;
}

export interface SystemPromptCacheSplit {
  /** Byte-stable system message text: the sections above the boundary. */
  systemText: string;
  /** Stable sections, byte-identical to their source, for segmented candidates. */
  stableSegments: CacheSplitSegment[];
  /** Volatile sections, in order, carrying their original Context kind. */
  trailingSegments: CacheSplitSegment[];
}

export function splitSystemPromptForCache(bundle: { segments: readonly CacheSplitSegment[] }): SystemPromptCacheSplit {
  const stable: string[] = [];
  const stableSegments: CacheSplitSegment[] = [];
  const trailingSegments: CacheSplitSegment[] = [];
  let boundarySeen = false;
  for (const [index, segment] of bundle.segments.entries()) {
    const markerIndex = boundarySeen ? -1 : segment.text.indexOf(CACHE_BOUNDARY_MARKER);
    if (!boundarySeen && markerIndex < 0) {
      stable.push(segment.text);
      stableSegments.push(toContextSegment(segment, index));
      continue;
    }
    boundarySeen = true;
    if (markerIndex >= 0) {
      const stableTail = segment.text.slice(0, markerIndex).replace(/\s+$/u, '');
      if (stableTail) {
        stable.push(stableTail);
        stableSegments.push({ ...toContextSegment(segment, index), text: stableTail });
      }
    }
    trailingSegments.push({
      ...toContextSegment(segment, index),
      text: markerIndex < 0
        ? segment.text
        : segment.text.slice(markerIndex + CACHE_BOUNDARY_MARKER.length).replace(/^[\s-]+/u, ''),
    });
  }
  return { systemText: stable.join(''), stableSegments, trailingSegments };
}

function toContextSegment(segment: CacheSplitSegment, index: number): CacheSplitSegment {
  return {
    id: segment.id,
    order: index,
    text: segment.text,
    kind: segment.kind,
    source: segment.source,
    priority: segment.priority,
    required: segment.required,
    sensitive: segment.sensitive,
    scope: segment.scope,
  };
}
