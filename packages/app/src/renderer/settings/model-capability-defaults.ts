// Defaults LS applies to a user-declared model that leaves capability fields out.
//
// Declared locally rather than imported from `@littlesheep/config`, for the same
// reason as the protocol list in this folder: importing config's VALUES drags its
// Node-only loader into the renderer bundle and breaks the build, and `import type`
// cannot supply a runtime number. `model-capability-defaults.test.ts` asserts these
// match config's constants, so the duplication cannot drift silently.
//
// These are DEFAULTS, not vendor facts. The editor labels them as such: an assumed
// window still lets a run work, but a user who knows the real number should replace
// it, and nothing here may be presented as a measurement.

/** Context window assumed when the user declares none. Must equal config's. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 256_000
/** Max output assumed when the user declares none. Must equal config's. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000

/** `256000` → `256K`, for short labels and placeholders. */
export function formatTokenBudget(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`
  if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(0))}K`
  return String(tokens)
}
