// @littlesheep/prompt — cache-boundary.ts
// Marker that splits stable prompt prefix from volatile suffix.
//
// Content ABOVE this marker is cache-stable (workspace, tools, persona).
// Content BELOW changes per-turn (bootstrap files, prelude, session state).
// Backends with prefix caches can reuse the stable prefix across turns.
//
// The split itself is not a string operation: the builder marks the first
// below-boundary section with this marker and publishes the two halves as
// `stableText`/`stableSegments` and `trailingSegments`, and the request assembler
// emits each trailing section as its own message. A string-level splitter used to
// live here; it had no production caller once the builder owned the boundary, so
// it is gone rather than kept as a second definition of where the boundary is.

/** HTML comment marker inserted between stable and volatile sections. */
export const CACHE_BOUNDARY_MARKER = '<!-- LITTLESHEEP_CACHE_BOUNDARY -->';
