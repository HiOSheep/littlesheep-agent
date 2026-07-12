// @littlesheep/safety — validate.ts
// Pure-function validator for memory-bound content. No I/O.
//
// Two-phase scan:
//   1. Length check (defence against memory bloat / DoS via huge entries).
//   2. Strip-severity patterns: remove matched chars globally (e.g. zero-width).
//   3. Block-severity patterns: scan the cleaned text; first match rejects.
//
// The validator returns the cleaned text on success so callers can persist the
// sanitized form (zero-width chars don't survive to disk).

import { INJECTION_PATTERNS } from './patterns.js';

export interface ValidateOptions {
  /** Max chars per entry. Default 500. */
  maxLength?: number;
  /** Optional source label for diagnostics. */
  source?: string;
}

export interface ValidationResult {
  ok: boolean;
  /** Present when ok=false. Human-readable reason. */
  reason?: string;
  /** Present when ok=false. Pattern id or 'too_long'. */
  matchedPatternId?: string;
  /** Cleaned text (strip patterns applied). Present on both ok=true and ok=false. */
  cleaned?: string;
}

export const DEFAULT_MAX_LENGTH = 500;

/**
 * Validate a chunk of text destined for memory storage.
 *
 * Returns `{ ok: true, cleaned }` on success, or `{ ok: false, reason, matchedPatternId }`
 * on rejection. The cleaned text is returned so the caller can persist the
 * sanitized form rather than the raw input.
 */
export function validateMemoryContent(
  text: string,
  opts: ValidateOptions = {},
): ValidationResult {
  const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;

  if (text.length > maxLength) {
    return {
      ok: false,
      reason: `exceeds max length ${maxLength}`,
      matchedPatternId: 'too_long',
    };
  }

  // Phase 1: strip-severity patterns (global replace).
  let cleaned = text;
  for (const p of INJECTION_PATTERNS) {
    if (p.severity !== 'strip') continue;
    const flags = p.regex.flags.includes('g') ? p.regex.flags : p.regex.flags + 'g';
    const globalRegex = new RegExp(p.regex.source, flags);
    cleaned = cleaned.replace(globalRegex, '');
  }

  // Phase 2: block-severity patterns on cleaned text.
  for (const p of INJECTION_PATTERNS) {
    if (p.severity !== 'block') continue;
    if (p.regex.test(cleaned)) {
      return {
        ok: false,
        reason: `matched injection pattern: ${p.id}`,
        matchedPatternId: p.id,
        cleaned,
      };
    }
  }

  return { ok: true, cleaned };
}
