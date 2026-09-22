// @littlesheep/types — tool.ts
// AgentTool contract + execution context + results.

import type { ToolResult } from './message.js';
import type { SessionId } from './session.js';
import type { PermissionPolicyId } from './runtime-contracts.js';
import type { NetworkReadPolicy, WebEvidenceSink, WebRetrievalRuntimePort } from './web-retrieval.js';
import type { DurableEffectOutcomeQueryResult, DurableEffectProjection, EffectReconcileContext } from './durable-harness.js';

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

/** One file version the model actually observed through a read. */
export interface FileObservationSnapshot {
  /** sha256 of the raw bytes that were read; the authoritative revision. */
  version: string;
  /** Size of those bytes; a fast filter, never the only criterion. */
  sizeBytes: number;
  /** Modification time of those bytes; a fast filter, never the only criterion. */
  mtimeMs: number;
  /**
   * `full` means the model saw the whole file unmodified. `partial` means it saw
   * `visibleLineRange` only, so an edit may be checked against that range.
   */
  coverage: 'full' | 'partial';
  /** 1-based inclusive line range the model saw; required when partial. */
  visibleLineRange?: { start: number; end: number };
  /** ISO timestamp of the read that produced this observation. */
  observedAt: string;
  /** Run that produced the observation; part of the audit trail only. */
  runId: string;
}

/** Why an observation could not be used to authorize a mutation. */
export type FileObservationFailureKind =
  /** Nothing was observed for this path: the model must read it first. */
  | 'observation_missing'
  /** Something was observed, but the file changed since. */
  | 'observation_stale'
  /** The path cannot carry a reliable revision (link, special file, unit). */
  | 'observation_unsupported'
  /** An opaque mutation (a shell command) is in flight; observations are frozen. */
  | 'observation_suspended'
  /** A create-only write found the target already present. */
  | 'target_exists';

export type FileObservationLookup =
  | { ok: true; snapshot: FileObservationSnapshot }
  | { ok: false; errorKind: FileObservationFailureKind; message: string };

/**
 * Host-owned, session-scoped record of the file versions the model observed.
 *
 * It lives in memory only: a Runner rebuild or an application restart drops it,
 * so the model must read again before mutating. It is deliberately separate from
 * `versioning` (the durable rollback preimage): that one records what a file
 * looked like *before a mutation* and is settled per run, while this one records
 * what the model *saw*, is revisited on every read and write, and dies with the
 * session table. A tool may never take the model's own hash on trust; only this
 * port can testify that a specific version was delivered to the model.
 */
export interface FileObservationPort {
  /** Register a successfully delivered read. Suspended ports ignore this. */
  recordRead(input: { absPath: string; snapshot: FileObservationSnapshot }): void;
  /** Look up the observation for a path without deciding anything. */
  lookup(absPath: string): FileObservationLookup;
  /** Drop the observation for one path (after a mutation or an opaque command). */
  invalidate(absPath: string): void;
  /** Drop every observation this port holds (conservative invalidation). */
  invalidateAll(): void;
  /**
   * Freeze the port while an opaque mutation may be running: nothing new is
   * registered and existing observations cannot authorize a write. The returned
   * function releases one freeze.
   */
  suspend(): () => void;
  /**
   * Serialize "re-verify then write" for one canonical path across every session
   * of the same host process. Cross-process writers remain out of scope.
   */
  withPathLock<T>(absPath: string, fn: () => Promise<T>): Promise<T>;
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
  /**
   * Host-owned record of the file versions this session's model observed. Read
   * tools register into it; overwriting tools require it. When it is absent the
   * host has not wired observation tracking, so an overwrite of an existing file
   * is refused instead of silently skipping the check.
   */
  observation?: FileObservationPort;
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
  /**
   * Optional recovery-time reconciliation. A tool that can authoritatively
   * query the state its own effect produced implements this so crash recovery
   * settles the effect as succeeded/failed instead of conservatively unknown.
   * It must observe only; it must never repeat the effect.
   */
  reconcileEffect?(effect: DurableEffectProjection, ctx: EffectReconcileContext): Promise<DurableEffectOutcomeQueryResult>;
  /**
   * Optional bounded, redacted recovery key for `reconcileEffect`.
   *
   * LS persists only the returned value inside the effect intent, so it must
   * identify the effect target (path, external id, idempotency token) and must
   * never carry payload text or secrets. Anything outside the bounded shape is
   * dropped and the effect stays conservatively `unknown`.
   */
  reconciliationKey?(input: unknown): unknown;
}

/** Registry lookup result. */
export interface ToolRegistration {
  tool: AgentTool;
  /** Source: 'builtin' | 'mcp:<serverName>' | 'plugin'. */
  source: string;
}
