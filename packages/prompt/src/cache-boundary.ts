// @littlesheep/prompt — cache-boundary.ts
// Marker that splits stable prompt prefix from volatile suffix.
//
// Content ABOVE this marker is cache-stable (workspace, tools, persona).
// Content BELOW changes per-turn (bootstrap files, prelude, session state).
// Backends with prefix caches can reuse the stable prefix across turns.

/** HTML comment marker inserted between stable and volatile sections. */
export const CACHE_BOUNDARY_MARKER = '<!-- LITTLESHEEP_CACHE_BOUNDARY -->';

/** Split a rendered prompt at the cache boundary. */
export function splitAtBoundary(prompt: string): { stable: string; volatile: string } {
  const idx = prompt.indexOf(CACHE_BOUNDARY_MARKER);
  if (idx < 0) return { stable: prompt, volatile: '' };
  const stable = prompt.slice(0, idx).trimEnd();
  const volatile = prompt.slice(idx + CACHE_BOUNDARY_MARKER.length).trimStart();
  return { stable, volatile };
}
