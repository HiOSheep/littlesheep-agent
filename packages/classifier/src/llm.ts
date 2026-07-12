// @littlesheep/classifier — llm.ts
// LLM fallback classifier. Called when rules don't match or confidence is low.

import type { LlmClient, ChatMessage } from '@littlesheep/llm';
import type { Classification, Message, MessageClass } from '@littlesheep/types';

const SYSTEM_PROMPT = `You are a message classifier for an AI agent. Classify the user's last message into exactly one of:

- "chat": casual conversation, greetings, small talk, opinions, factual questions, confirmations, or continuations of an ongoing dialogue.
- "problem": a task that requires tools, multi-step work, file operations, coding, debugging, or execution.
- "unclear": the message is completely nonsensical or empty.

Respond ONLY with a JSON object, no markdown:
{"type": "chat"|"problem"|"unclear", "confidence": 0.0-1.0, "reason": "short explanation"}

Guidelines:
- If the message asks to do something concrete → "problem".
- If it's a greeting, chitchat, a question, a confirmation, or a response to previous context → "chat".
- When in doubt, default to "chat" — the agent should try to understand from context, not ask the user.
- Only use "unclear" for truly meaningless input (e.g. random characters, empty message).
- confidence reflects how sure you are.`;

/** Extract text content from a Message. */
function textOf(m: Message): string {
  return m.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

/** Classify using an LLM. Always returns a Classification (never throws). */
export async function classifyByLlm(
  message: Message,
  history: Message[],
  llm: LlmClient,
  model: string,
): Promise<Classification> {
  const recentHistory = history.slice(-5);
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...recentHistory.map((m) => ({
      role: (m.role === 'assistant' ? 'assistant' : 'user') as 'assistant' | 'user',
      content: textOf(m),
    })),
    { role: 'user', content: textOf(message) || '(empty message)' },
  ];

  let content: string;
  try {
    const res = await llm.chat({ model, messages, temperature: 0, max_tokens: 200 });
    content = res.content;
  } catch (err) {
    return {
      type: 'chat',
      confidence: 0.3,
      source: 'llm',
      reason: `llm call failed: ${(err as Error).message}`,
    };
  }

  // Try to extract JSON from response (model may wrap in markdown)
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { type?: string; confidence?: number; reason?: string };
      const validTypes: MessageClass[] = ['chat', 'problem', 'unclear'];
      if (parsed.type && validTypes.includes(parsed.type as MessageClass)) {
        return {
          type: parsed.type as MessageClass,
          confidence: typeof parsed.confidence === 'number'
            ? Math.max(0, Math.min(1, parsed.confidence))
            : 0.6,
          source: 'llm',
          reason: parsed.reason,
        };
      }
    } catch {
      // fall through to fallback
    }
  }

  return {
    type: 'chat',
    confidence: 0.4,
    source: 'llm',
    reason: 'failed to parse LLM response',
  };
}
