// @littlesheep/types — tool.ts
// AgentTool contract + execution context + results.

import type { ToolCall, ToolResult } from './message.js';
import type { SessionId } from './session.js';

/**
 * A schema validator. Zod schemas satisfy this structurally; we keep types
 * package free of zod so consumers can plug any validator.
 */
export interface ToolSchema<T = unknown> {
  /** Validate + parse raw input. Throw on invalid. */
  parse(input: unknown): T;
  /** JSON Schema for the model (used in prompt). */
  jsonSchema?: unknown;
}

/** Per-call execution context handed to a tool. */
export interface ToolContext {
  /** Calling session. */
  sessionId: SessionId;
  /** Calling run id. */
  runId: string;
  /** Working directory for file/exec tools. */
  cwd: string;
  /** Host-owned roots that built-in mutation tools must treat as read-only. */
  protectedWriteRoots?: readonly string[];
  /** Approval callback: returns true if the action is permitted. */
  approve?: (action: string, detail?: unknown) => Promise<boolean>;
  /** Abort signal for the owning run. */
  signal?: AbortSignal;
  /** Logger sink. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

/** Outcome of an approval check. */
export type ApprovalResult =
  | { decision: 'approved'; reason?: string }
  | { decision: 'denied'; reason: string }
  | { decision: 'escalate'; reason: string };

/** The tool contract. Every built-in + MCP-bridged tool implements this. */
export interface AgentTool {
  /** Unique tool name. Matches ToolCall.name. */
  name: string;
  /** Short description shown to the model in the prompt. */
  description: string;
  /** Input validator (zod schema or custom). */
  inputSchema: ToolSchema;
  /** Whether this tool requires approval before executing. */
  requiresApproval?: boolean;
  /** Execute the tool. Must not throw — return ok:false on error. */
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/** Registry lookup result. */
export interface ToolRegistration {
  tool: AgentTool;
  /** Source: 'builtin' | 'mcp:<serverName>' | 'plugin'. */
  source: string;
}
