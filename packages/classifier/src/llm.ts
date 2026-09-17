// @littlesheep/classifier — llm.ts
// LLM fallback classifier. Called when rules don't match or confidence is low.

import type { ChatRequest, ChatResponse, LlmClient, ChatMessage } from '@littlesheep/llm';
import {
  activityFromMessageClass,
  messageClassFromActivity,
  type AgentActivity,
  type Classification,
  type Message,
  type MessageClass,
} from '@littlesheep/types';

const SYSTEM_PROMPT = `Choose the next LittleSheep activity for the user's latest message.

- "respond": answer or continue the conversation directly. This includes questions about LS capabilities or current status. When a detail is genuinely missing, ask for it in your reply.
- "execute": the user asks LS to inspect, change, create, run, or otherwise complete a concrete task with tools.

Prefer "respond" when ordinary conversation can resolve the message. Do not choose "execute" merely because the message mentions an action word. Never stall on ambiguity: answer with a best-effort response that states its assumption, or ask for the single missing fact inside that reply.
The latest user message is authoritative. A request to reply, answer, say, return, or output text is "respond" even when that text mentions testing, calibration, code, or a tool name.

Return only JSON:
{"activity":"respond"|"execute","confidence":0.0-1.0,"reason":"short explanation"}`;

const ACTIVITIES: readonly AgentActivity[] = ['respond', 'execute', 'clarify'];
const LEGACY_TYPES: readonly MessageClass[] = ['chat', 'problem', 'unclear'];

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
  onRequest?: (request: ChatRequest) => ChatRequest | void | Promise<ChatRequest | void>,
  onResponse?: (request: ChatRequest, response: ChatResponse) => void | Promise<void>,
  beforeRequest?: (request: ChatRequest) => void | Promise<void>,
  onError?: (request: ChatRequest, error: unknown) => void | Promise<void>,
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
  let preparedRequest: ChatRequest | undefined;
  try {
    const request: ChatRequest = { model, messages, temperature: 0, max_tokens: 200 };
    preparedRequest = await onRequest?.(request) ?? request;
    await beforeRequest?.(preparedRequest);
    const res = await llm.chat(preparedRequest);
    await onResponse?.(preparedRequest, res);
    content = res.content;
  } catch (err) {
    if (preparedRequest) await onError?.(preparedRequest, err);
    return {
      activity: 'respond',
      type: 'chat',
      confidence: 0.3,
      source: 'llm',
      reasonCode: 'classifier_failed',
      reason: `llm call failed: ${(err as Error).message}`,
    };
  }

  // Try to extract JSON from response (model may wrap in markdown)
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        activity?: string;
        type?: string;
        confidence?: number;
        reason?: string;
      };
      const activity = parseActivity(parsed.activity, parsed.type);
      if (activity) {
        return {
          activity,
          type: messageClassFromActivity(activity),
          confidence: typeof parsed.confidence === 'number'
            ? Math.max(0, Math.min(1, parsed.confidence))
            : 0.6,
          source: 'llm',
          reasonCode: activity === 'respond'
            ? 'llm_route_respond'
            : activity === 'execute'
              ? 'llm_route_execute'
              : 'llm_route_clarify',
          reason: parsed.reason,
        };
      }
    } catch {
      // fall through to fallback
    }
  }

  return {
    activity: 'respond',
    type: 'chat',
    confidence: 0.4,
    source: 'llm',
    reasonCode: 'classifier_failed',
    reason: 'failed to parse LLM response',
  };
}

function parseActivity(activity: string | undefined, legacyType: string | undefined): AgentActivity | undefined {
  if (activity && ACTIVITIES.includes(activity as AgentActivity)) return activity as AgentActivity;
  if (legacyType && LEGACY_TYPES.includes(legacyType as MessageClass)) {
    return activityFromMessageClass(legacyType as MessageClass);
  }
  return undefined;
}
