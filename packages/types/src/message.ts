// @littlesheep/types — message.ts
// Core message types persisted in session JSONL transcripts.

import type { ClarificationRequest, ClarificationResponse } from './clarification.js';
import type { WebEvidenceProjection } from './web-retrieval.js';

/** LLM call categories that may author natural language shown as an LS reply. */
export type UserFacingReplyPurpose =
  | 'reply'
  | 'ask_user'
  | 'decide'
  | 'decide_explicit_tool'
  | 'execute_tool_loop'
  | 'execute_final_reply'
  | 'recover';

/** Auditable proof that a visible LS reply was authored by a model call. */
export interface ReplyProvenance {
  version: 1;
  source: 'llm';
  purpose: UserFacingReplyPurpose;
  /** Provider API request that generated the text published to the user. */
  modelRequestId: string;
  modelRequestIndex: number;
  provider: string;
  model: string;
  generatedAt: string;
  /** Number of additional Provider API calls required to obtain a unique reply. */
  rewriteCount: number;
}

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
  /**
   * Run-local content for the current model tool loop. Harness must remove it
   * before writing ToolResult into messages, checkpoints, logs or AgentResult.
   */
  modelOutput?: unknown;
  /** Human-readable error text when ok === false. */
  error?: string;
  /** Wall-clock duration in ms. */
  durationMs?: number;
  /** Whether the result was sanitized (truncated / image-stripped). */
  sanitized?: boolean;
  /** Optional structured metadata (counts, exit codes, etc.). */
  meta?: Record<string, unknown>;
  /** Bounded network evidence summary. Full queries and fetched content are forbidden here. */
  webEvidence?: WebEvidenceProjection;
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
  /** Source contract for natural language rendered as an LS reply. */
  replyProvenance?: ReplyProvenance;
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

/** Stable comparison form used by the durable user-facing reply registry. */
export function normalizeUserFacingReply(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
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
