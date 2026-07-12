// @littlesheep/classifier — index.ts
// Hybrid classifier: rules fast path + LLM fallback.

import type { Classification, Message } from '@littlesheep/types';
import type { LlmClient } from '@littlesheep/llm';
import { classifyByRules } from './rules.js';
import { classifyByLlm } from './llm.js';

export interface ClassifierOptions {
  /** LLM client for fallback. */
  llm: LlmClient;
  /** Model ref (e.g. "openai/gpt-4o"). */
  model: string;
  /** Minimum confidence for rules result to bypass LLM. Default 0.7. */
  rulesConfidenceThreshold?: number;
  /** Recent history (for LLM context). */
  history?: Message[];
}

/** Extract text from a Message. */
function textOf(m: Message): string {
  return m.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

/**
 * Classify a message.
 * 1. Try rules fast path. If confidence >= threshold → return.
 * 2. Otherwise call LLM.
 */
export async function classify(
  message: Message,
  history: Message[],
  opts: ClassifierOptions,
): Promise<Classification> {
  const threshold = opts.rulesConfidenceThreshold ?? 0.7;
  const text = textOf(message);
  const ruleResult = classifyByRules(text);
  if (ruleResult && ruleResult.confidence >= threshold) {
    return ruleResult;
  }
  return classifyByLlm(message, history, opts.llm, opts.model);
}

export { classifyByRules, listRules } from './rules.js';
export { classifyByLlm } from './llm.js';
export type { Rule } from './rules.js';
