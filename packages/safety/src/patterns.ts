// @littlesheep/safety — patterns.ts
// Catalog of prompt-injection patterns to detect in memory writes.
//
// `severity` controls how the validator treats a match:
//   - 'block': reject the write entirely + quarantine
//   - 'strip': silently remove the matched chars/words, then continue scanning
//
// Patterns are intentionally broad (false-positive tolerant) because the
// downstream cost of a persistent prompt injection is high. Stripped patterns
// are zero-width / invisible chars where removal is always safe.

export interface InjectionPattern {
  /** Stable id used in quarantine metadata + tests. */
  id: string;
  /** Regex to test against candidate text. */
  regex: RegExp;
  /** How to handle a match. */
  severity: 'block' | 'strip';
  /** Human-readable note for debugging. */
  description?: string;
}

export const INJECTION_PATTERNS: ReadonlyArray<InjectionPattern> = [
  {
    id: 'ignore_previous_instructions',
    regex: /ignore (all )?previous (instructions|prompts|rules|directives)/i,
    severity: 'block',
    description: 'Direct attempt to override prior instructions',
  },
  {
    id: 'you_are_now',
    regex: /\byou are now\b/i,
    severity: 'block',
    description: 'Role reassignment',
  },
  {
    id: 'when_user_asks',
    regex: /when (the )?user (asks|says|requests|types|inputs)/i,
    severity: 'block',
    description: 'Conditional behavior injection',
  },
  {
    id: 'assistant_role_marker',
    regex: /(^|\n)\s*#{1,6}\s*(assistant|system|user)\s*[:\n]/i,
    severity: 'block',
    description: 'ChatML-style role markers (### Assistant:)',
  },
  {
    id: 'chatml_marker',
    regex: /<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>/i,
    severity: 'block',
    description: 'ChatML special tokens',
  },
  {
    id: 'system_override',
    regex: /\b(system (prompt|message|instructions?|role))\b/i,
    severity: 'block',
    description: 'System prompt override attempt',
  },
  {
    id: 'new_instructions_prelude',
    regex: /\bnew (instructions?|rules?|directive)\b/i,
    severity: 'block',
    description: 'Prelude announcing new instructions',
  },
  {
    id: 'zero_width_unicode',
    regex: /[\u200B\u200C\u200D\uFEFF]/,
    severity: 'strip',
    description: 'Zero-width Unicode chars (invisible instruction smuggling)',
  },
];
