// @littlesheep/classifier — index.ts
// Hybrid classifier: rules fast path + LLM fallback.

import type { Classification, Message } from '@littlesheep/types';
import type { ChatRequest, ChatResponse, LlmClient } from '@littlesheep/llm';
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
  /** Observe the actual fallback request before it is sent. */
  onRequest?: (request: ChatRequest) => ChatRequest | void | Promise<ChatRequest | void>;
  /** Observe the fallback response with the exact prepared request. */
  onResponse?: (request: ChatRequest, response: ChatResponse) => void | Promise<void>;
  /** Durable gate awaited immediately before Provider I/O. */
  beforeRequest?: (request: ChatRequest) => void | Promise<void>;
  /** Record transport/cancellation failures for the exact prepared request. */
  onError?: (request: ChatRequest, error: unknown) => void | Promise<void>;
  /** Full system prompt for the LLM fallback; the caller prepends the shared head. */
  systemPrompt?: string;
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
  return classifyByLlm(
    message,
    history,
    opts.llm,
    opts.model,
    opts.onRequest,
    opts.onResponse,
    opts.beforeRequest,
    opts.onError,
    opts.systemPrompt,
  );
}

export {
  classifyByRules,
  extractExplicitToolInstructionNames,
  isMemoryRecallRequest,
  listRules,
} from './rules.js';
export { classifyByLlm } from './llm.js';
export type { Rule } from './rules.js';
