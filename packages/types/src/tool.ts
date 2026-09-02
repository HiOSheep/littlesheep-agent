// @littlesheep/types — tool.ts
// AgentTool contract + execution context + results.

import type { ToolResult } from './message.js';
import type { SessionId } from './session.js';
import type { PermissionPolicyId } from './runtime-contracts.js';
import type { NetworkReadPolicy, WebEvidenceSink, WebRetrievalRuntimePort } from './web-retrieval.js';

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
  /** Active movable application-data root that defines the logical LS container. */
  containerRoot?: string;
  /** Permission policy for this run; behavior profiles are intentionally separate. */
  permissionMode?: PermissionPolicyId;
  /** Approval callback: returns true if the action is permitted. */
  approve?: (action: string, detail?: unknown) => Promise<boolean>;
  /** Set only for the current invocation after the Harness has approved it. */
  approvalGranted?: boolean;
  /** Abort signal for the owning run. */
  signal?: AbortSignal;
  /** Immutable network-read policy resolved before the run starts. */
  networkPolicy?: Readonly<NetworkReadPolicy>;
  /** Host-owned bounded evidence sink; tools cannot replace the sink or persist page bodies through it. */
  webEvidenceSink?: WebEvidenceSink;
  /** Host-owned per-run public web retrieval port. */
  webRetrieval?: WebRetrievalRuntimePort;
  /** Logger sink. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  /** Host-owned durable preimage checkpoint hook for mutating file tools. */
  versioning?: {
    beforeFileMutation(filePath: string): Promise<void>;
    beforeWorkspaceMutation(workspacePath: string): Promise<void>;
  };
}

export type ToolResourceAccessMode = 'read' | 'write';

/** One runtime-owned resource lock used to decide whether tool calls may overlap. */
export interface ToolResourceAccess {
  key: string;
  mode: ToolResourceAccessMode;
}

/**
 * Tool execution policy. Unknown tools default to exclusive execution.
 * A parallel tool must identify every resource whose mutation order matters.
 */
export interface ToolExecutionPolicy {
  concurrency: 'parallel' | 'exclusive';
  resources?: (input: unknown, ctx: ToolContext) => readonly ToolResourceAccess[];
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
  /** Explicit runtime concurrency contract; omitted means exclusive. */
  execution?: ToolExecutionPolicy;
  /** Redact/hash input before approval UI, runtime events or persistence. */
  persistence?: {
    projectInput(input: unknown): unknown;
  };
  /** Execute the tool. Must not throw — return ok:false on error. */
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/** Registry lookup result. */
export interface ToolRegistration {
  tool: AgentTool;
  /** Source: 'builtin' | 'mcp:<serverName>' | 'plugin'. */
  source: string;
}
