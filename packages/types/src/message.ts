// @littlesheep/types — message.ts
// Core message types persisted in session JSONL transcripts.

import type { ClarificationRequest, ClarificationResponse } from './clarification.js';

/** Who authored a message. */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** A single tool call requested by the assistant. */
export interface ToolCall {
  /** Stable id for correlating the call with its result. */
  id: string;
  /** Registered tool name (must match an AgentTool.name). */
  name: string;
  /** JSON-serializable arguments object. */
  input: unknown;
}

/** The result returned by a tool execution. */
export interface ToolResult {
  /** Correlates with ToolCall.id. */
  callId: string;
  /** Whether the tool succeeded. Errors are still persisted. */
  ok: boolean;
  /** Structured output (string for text tools, object for rich tools). Omitted on failure. */
  output?: unknown;
  /** Human-readable error text when ok === false. */
  error?: string;
  /** Wall-clock duration in ms. */
  durationMs?: number;
  /** Whether the result was sanitized (truncated / image-stripped). */
  sanitized?: boolean;
  /** Optional structured metadata (counts, exit codes, etc.). */
  meta?: Record<string, unknown>;
}

/** A block of content within a message. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: ToolCall[] }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'reasoning'; text: string };

/** A single message record. One line in the session JSONL. */
export interface Message {
  /** Stable id (uuid or timestamp-based). */
  id: string;
  role: Role;
  /** Ordered content blocks. A message may mix text + tool_calls. */
  content: ContentBlock[];
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Owning session, when the message is part of a session. */
  sessionId?: string;
  /** Optional run id (which agent run produced this). */
  runId?: string;
  /** Stage that produced this message (for assistant messages). */
  stage?: StageName;
  /** Structured question represented by this assistant message. */
  clarificationRequest?: ClarificationRequest;
  /** Link from a user answer to the clarification it resolves. */
  clarificationResponse?: ClarificationResponse;
}

/** Convenience: a plain text message. */
export function textMessage(
  role: Role,
  text: string,
  extra?: Partial<Message>
): Message {
  return {
    id: extra?.id ?? crypto.randomUUID(),
    role,
    content: [{ type: 'text', text }],
    timestamp: extra?.timestamp ?? new Date().toISOString(),
    ...extra,
  };
}

/** Stage names that may tag a message (imported lazily to avoid cycle). */
type StageName =
  | 'enter'
  | 'classify'
  | 'reply'
  | 'ask_user'
  | 'decide'
  | 'execute'
  | 'recover'
  | 'evolve'
  | 'capture'
  | 'finalize';
