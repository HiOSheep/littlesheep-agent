// @littlesheep/runner — execution-log.ts
// Persists a full execution log per run: stage trace + tool I/O + reply + timing.
// Written once at the end of runner.run; read via runner.replay(runId).
//
// File layout: <dataDir>/execution-logs/<runId>.json
// Each file is a single JSON object (write-once, runId is a UUID — no conflicts).
//
// ToolCall pairing: extractToolCallPairs walks ctx.produced Message content
// blocks, matching ToolCall.id ↔ ToolResult.callId via a Map. This captures
// both the call (name, input) and the result (output, ok, error) — ctx.toolResults
// alone only has results without the corresponding call metadata.

import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN } from '@littlesheep/context';
import type {
  Message,
  ReplyProvenance,
  ToolCall,
  ToolResult,
  RunStatus,
  StageName,
  TaskExecutionResult,
  TaskBook,
  VerificationRecord,
  ClarificationRequest,
  ClarificationResponse,
  ResolvedRunConfig,
  ModelRequestSnapshot,
  ContextSnapshot,
  ToolInvocationRecord,
  ExecutionEvidence,
  MemoryIntentDecisionRecord,
  RuntimeMemoryKnownState,
  MemoryContinuityAssessment,
  RuntimeControlSnapshot,
  RuntimeEventQueueSnapshot,
  SessionRunSummary,
  VersionCheckpointSummary,
} from '@littlesheep/types';
import type { MemoryAccessLedger } from '@littlesheep/memory-tree';
import type { RuntimeResourceObservation } from './runtime-resource-observation.js';

/** A single tool call + its result, paired by id. */
export interface ToolCallRecord {
  call: ToolCall;
  result: ToolResult;
}

/** Stage trace entry (mirrors AgentRun.stages shape). */
export interface StageTraceEntry {
  name: StageName;
  startedAt: string;
  endedAt: string;
  ok: boolean;
}

/** A persisted execution log for one run. */
export interface ExecutionLog {
  runId: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  status: RunStatus;
  model: string;
  inboundText: string;
  reply: string;
  replyProvenance?: ReplyProvenance;
  error?: string;
  trace: StageTraceEntry[];
  taskExecution?: TaskExecutionResult;
  taskBook?: TaskBook;
  verificationHistory?: VerificationRecord[];
  memoryIntentDecisions?: MemoryIntentDecisionRecord[];
  memoryKnownState?: RuntimeMemoryKnownState;
  memoryContinuityAssessment?: MemoryContinuityAssessment;
  clarificationRequest?: ClarificationRequest;
  clarificationResponse?: ClarificationResponse;
  memoryAccess?: MemoryAccessLedger;
  resolvedRunConfig?: ResolvedRunConfig;
  modelRequests?: ModelRequestSnapshot[];
  contextSnapshots?: ContextSnapshot[];
  runtimeControl?: RuntimeControlSnapshot;
  runtimeEventQueue?: RuntimeEventQueueSnapshot;
  /** Links an interrupted/recoverable run to its durable runtime checkpoint. */
  runCheckpointId?: string;
  /** Two process-memory samples plus a coarse, non-identifying device class. */
  runtimeResources?: RuntimeResourceObservation;
  versionCheckpoint?: VersionCheckpointSummary;
  /** Bounded ids of memory/attachment resources that influenced this run. */
  resourceIds?: string[];
  resourceIdsTruncated?: boolean;
  toolCalls: ToolCallRecord[];
  toolInvocations?: ToolInvocationRecord[];
  toolInvocationsTruncated?: boolean;
  evidence?: ExecutionEvidence[];
  durationMs: number;
}

/** Input to write(): includes messages for tool-call extraction. */
export interface ExecutionLogInput {
  runId: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  status: RunStatus;
  model: string;
  inboundText: string;
  reply: string;
  replyProvenance?: ReplyProvenance;
  error?: string;
  trace: StageTraceEntry[];
  taskExecution?: TaskExecutionResult;
  taskBook?: TaskBook;
  verificationHistory?: VerificationRecord[];
  memoryIntentDecisions?: MemoryIntentDecisionRecord[];
  memoryKnownState?: RuntimeMemoryKnownState;
  memoryContinuityAssessment?: MemoryContinuityAssessment;
  clarificationRequest?: ClarificationRequest;
  clarificationResponse?: ClarificationResponse;
  memoryAccess?: MemoryAccessLedger;
  resolvedRunConfig?: ResolvedRunConfig;
  modelRequests?: ModelRequestSnapshot[];
  contextSnapshots?: ContextSnapshot[];
  runtimeControl?: RuntimeControlSnapshot;
  runtimeEventQueue?: RuntimeEventQueueSnapshot;
  runCheckpointId?: string;
  runtimeResources?: RuntimeResourceObservation;
  versionCheckpoint?: VersionCheckpointSummary;
  /** Authoritative records emitted by ToolExecutionService. */
  toolInvocations?: ToolInvocationRecord[];
  toolInvocationsTruncated?: boolean;
  messages: Message[];
  durationMs: number;
}

export interface ExecutionLogStoreOptions {
  /** Directory for execution log files. */
  rootDir: string;
}

export class ExecutionLogStore {
  private readonly rootDir: string;
  private readonly summaryWrites = new Map<string, Promise<void>>();

  constructor(opts: ExecutionLogStoreOptions) {
    this.rootDir = opts.rootDir;
  }

  /** File path: <rootDir>/<runId>.json */
  private filePath(runId: string): string {
    return join(this.rootDir, `${runId}.json`);
  }

  /**
   * Extract call+result pairs from a Message[] by matching ToolCall.id ↔
   * ToolResult.callId. Calls without results (interrupted runs) are omitted.
   */
  private extractToolCallPairs(messages: Message[]): ToolCallRecord[] {
    const calls = new Map<string, ToolCall>();
    const results = new Map<string, ToolResult>();
    for (const m of messages) {
      for (const c of m.content) {
        if (c.type === 'tool_calls') {
          for (const call of c.calls) calls.set(call.id, call);
        } else if (c.type === 'tool_result') {
          results.set(c.result.callId, c.result);
        }
      }
    }
    const pairs: ToolCallRecord[] = [];
    for (const [id, call] of calls) {
      const result = results.get(id);
      if (result) pairs.push({ call, result });
    }
    return pairs;
  }

  /** Write an execution log. Throws on I/O failure (caller wraps in try/catch). */
  async write(input: ExecutionLogInput): Promise<ExecutionLog> {
    const toolCalls = this.extractToolCallPairs(input.messages);
    const { toolInvocations, evidence, truncated } = buildToolEvidence(input, toolCalls);
    const modelRequests = boundedTail(input.modelRequests);
    const contextSnapshots = retainContextSnapshotAssociations(input.contextSnapshots, modelRequests);
    const resources = collectResourceIds({ ...input, contextSnapshots });
    const log: ExecutionLog = {
      runId: input.runId,
      sessionId: input.sessionId,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      status: input.status,
      model: input.model,
      inboundText: input.inboundText,
      reply: input.reply,
      replyProvenance: input.replyProvenance,
      error: input.error,
      trace: input.trace,
      taskExecution: input.taskExecution,
      taskBook: input.taskBook ? { ...input.taskBook, stageResults: undefined } : undefined,
      verificationHistory: input.verificationHistory,
      memoryIntentDecisions: input.memoryIntentDecisions,
      memoryKnownState: input.memoryKnownState,
      memoryContinuityAssessment: input.memoryContinuityAssessment,
      clarificationRequest: input.clarificationRequest,
      clarificationResponse: input.clarificationResponse,
      memoryAccess: input.memoryAccess,
      resolvedRunConfig: input.resolvedRunConfig,
      modelRequests,
      contextSnapshots,
      runtimeControl: input.runtimeControl,
      runtimeEventQueue: input.runtimeEventQueue,
      runCheckpointId: input.runCheckpointId,
      runtimeResources: input.runtimeResources,
      versionCheckpoint: input.versionCheckpoint,
      resourceIds: resources.ids.length > 0 ? resources.ids : undefined,
      resourceIdsTruncated: resources.truncated || undefined,
      toolCalls,
      toolInvocations,
      toolInvocationsTruncated: truncated || undefined,
      evidence,
      durationMs: input.durationMs,
    };
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.filePath(input.runId), JSON.stringify(log, null, 2), 'utf8');
    return log;
  }

  /** Attach the post-run checkpoint after the audit record itself has been written. */
  async attachVersionCheckpoint(
    runId: string,
    versionCheckpoint: VersionCheckpointSummary,
    durationMs?: number,
  ): Promise<void> {
    const file = this.filePath(runId);
    const parsed = JSON.parse(await readFile(file, 'utf8')) as ExecutionLog;
    if (parsed.runId !== runId) throw new Error(`execution log run id mismatch: ${runId}`);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({
        ...parsed,
        versionCheckpoint,
        durationMs: durationMs ?? parsed.durationMs,
      }, null, 2), 'utf8');
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Read an execution log. Returns null if not found or corrupt (never throws). */
  async read(runId: string): Promise<ExecutionLog | null> {
    const file = this.filePath(runId);
    if (!existsSync(file)) return null;
    try {
      const raw = await readFile(file, 'utf8');
      return JSON.parse(raw) as ExecutionLog;
    } catch {
      return null;
    }
  }

  /** Read the bounded last-run summary associated with a session. */
  async readLatestForSession(sessionId: string): Promise<SessionRunSummary | null> {
    const file = this.latestSummaryPath(sessionId);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
      if (!isLatestSummaryEnvelope(parsed) || parsed.sessionId !== sessionId) return null;
      return parsed.summary;
    } catch {
      return null;
    }
  }

  /** Atomically replace one session's bounded last-run summary. */
  async writeLatestForSession(sessionId: string, summary: SessionRunSummary): Promise<void> {
    const previous = this.summaryWrites.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const existing = await this.readLatestForSession(sessionId);
      if (existing && Date.parse(existing.endedAt) > Date.parse(summary.endedAt)) return;

      const directory = join(this.rootDir, 'latest-by-session');
      const file = this.latestSummaryPath(sessionId);
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      await mkdir(directory, { recursive: true });
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, sessionId, summary }, null, 2), 'utf8');
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.summaryWrites.set(sessionId, operation);
    try {
      await operation;
    } finally {
      if (this.summaryWrites.get(sessionId) === operation) this.summaryWrites.delete(sessionId);
    }
  }

  /** List all runIds that have execution logs. */
  async list(): Promise<string[]> {
    if (!existsSync(this.rootDir)) return [];
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(this.rootDir);
    return entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  }

  private latestSummaryPath(sessionId: string): string {
    const key = createHash('sha256').update(sessionId).digest('hex');
    return join(this.rootDir, 'latest-by-session', `${key}.json`);
  }
}

const MAX_TOOL_INVOCATIONS_PER_LOG = 256;
const MAX_RESOURCE_IDS_PER_LOG = 256;

interface LatestSummaryEnvelope {
  version: 1;
  sessionId: string;
  summary: SessionRunSummary;
}

function isLatestSummaryEnvelope(value: unknown): value is LatestSummaryEnvelope {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Partial<LatestSummaryEnvelope>;
  const summary = envelope.summary as Partial<SessionRunSummary> | undefined;
  return envelope.version === 1
    && typeof envelope.sessionId === 'string'
    && summary?.version === 1
    && typeof summary.runId === 'string'
    && typeof summary.startedAt === 'string'
    && typeof summary.endedAt === 'string'
    && typeof summary.durationMs === 'number'
    && !!summary.tools
    && typeof summary.tools.total === 'number'
    && Array.isArray(summary.tools.recent);
}

function collectResourceIds(input: ExecutionLogInput): { ids: string[]; truncated: boolean } {
  const uniqueIds = new Set<string>();
  for (const snapshot of input.contextSnapshots ?? []) {
    for (const item of snapshot.items) {
      if ((item.source.kind === 'memory'
        || item.source.kind === 'attachment'
        || item.source.kind === 'runtime_event') && item.source.id) {
        uniqueIds.add(item.source.id);
      }
    }
  }
  for (const record of input.memoryAccess?.records ?? []) {
    for (const fragmentId of record.fragmentIds) uniqueIds.add(fragmentId);
  }
  const all = [...uniqueIds];
  return { ids: all.slice(0, MAX_RESOURCE_IDS_PER_LOG), truncated: all.length > MAX_RESOURCE_IDS_PER_LOG };
}

function boundedTail<T>(values: readonly T[] | undefined): T[] | undefined {
  if (!values) return undefined;
  return values.length <= MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN
    ? [...values]
    : values.slice(-MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN);
}

/**
 * Keep the request tail's referenced snapshots even when legacy callers supply
 * arrays with different windows or ordering. Unreferenced snapshots still use
 * the newest tail, and the result never exceeds the shared observation cap.
 */
function retainContextSnapshotAssociations(
  snapshots: readonly ContextSnapshot[] | undefined,
  requests: readonly ModelRequestSnapshot[] | undefined,
): ContextSnapshot[] | undefined {
  if (!snapshots) return undefined;
  if (snapshots.length <= MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN) return [...snapshots];

  const availableIds = new Set(snapshots.map((snapshot) => snapshot.id));
  const requiredIds = new Set(
    (requests ?? [])
      .map((request) => request.contextSnapshotId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0 && availableIds.has(id)),
  );
  const tail = snapshots.slice(-MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN);
  const retainedUnreferenced = tail.filter((snapshot) => !requiredIds.has(snapshot.id));
  const unreferencedCapacity = Math.max(0, MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN - requiredIds.size);
  const retainedUnreferencedIds = new Set(
    (unreferencedCapacity > 0 ? retainedUnreferenced.slice(-unreferencedCapacity) : [])
      .map((snapshot) => snapshot.id),
  );
  const selectedIds = new Set([...requiredIds, ...retainedUnreferencedIds]);

  // Preserve source order so request/context timelines stay readable.
  return snapshots
    .filter((snapshot) => selectedIds.has(snapshot.id))
    .filter((snapshot, index, all) => all.findIndex((candidate) => candidate.id === snapshot.id) === index)
    .slice(-MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN);
}

function buildToolEvidence(
  input: ExecutionLogInput,
  pairs: ToolCallRecord[],
): { toolInvocations: ToolInvocationRecord[]; evidence: ExecutionEvidence[]; truncated: boolean } {
  if (input.toolInvocations !== undefined) {
    const selected = input.toolInvocations.slice(0, MAX_TOOL_INVOCATIONS_PER_LOG).map((record) => structuredClone(record));
    return {
      toolInvocations: selected,
      evidence: buildInvocationEvidence(input, selected),
      truncated: input.toolInvocationsTruncated === true || input.toolInvocations.length > selected.length,
    };
  }

  // Compatibility path for logs produced before ToolExecutionService became
  // the runtime authority. Status inference is intentionally confined here.
  const selected = pairs.slice(0, MAX_TOOL_INVOCATIONS_PER_LOG);
  const toolInvocations = selected.map(({ call, result }): ToolInvocationRecord => {
    const status = toolStatus(result);
    const evidenceId = `${input.runId}:evidence:tool:${call.id}`;
    return {
      version: 1,
      id: `${input.runId}:tool:${call.id}`,
      callId: call.id,
      runId: input.runId,
      sessionId: input.sessionId as import('@littlesheep/types').SessionId,
      stepId: typeof result.meta?.stepId === 'string' ? result.meta.stepId : undefined,
      toolName: call.name,
      toolSource: 'unknown',
      status,
      proposedAt: input.startedAt,
      endedAt: input.endedAt,
      inputHash: hashJson(call.input),
      inputSummary: summarizeInput(call.input),
      approval: approvalRecord(status),
      outputSummary: result.output === undefined
        ? undefined
        : `output present (${String(result.output).length} characters)`,
      outputSanitized: result.sanitized === true,
      errorKind: status === 'succeeded' ? undefined : status,
      durationMs: result.durationMs,
      evidenceIds: [evidenceId],
    };
  });
  return {
    toolInvocations,
    evidence: buildInvocationEvidence(input, toolInvocations),
    truncated: pairs.length > selected.length,
  };
}

function buildInvocationEvidence(
  input: ExecutionLogInput,
  toolInvocations: readonly ToolInvocationRecord[],
): ExecutionEvidence[] {
  return toolInvocations.map((record): ExecutionEvidence => ({
    version: 1,
    id: record.evidenceIds[0] ?? `${input.runId}:evidence:tool:${record.id}`,
    runId: input.runId,
    sessionId: input.sessionId as import('@littlesheep/types').SessionId,
    stepId: record.stepId,
    kind: 'tool_result',
    status: record.status === 'succeeded' ? 'pass' : 'fail',
    sourceRef: `tool:${record.id}`,
    summary: record.status === 'succeeded'
      ? `Tool ${record.toolName} completed successfully.`
      : `Tool ${record.toolName} ended with status ${record.status}.`,
    createdAt: input.endedAt,
    sensitive: true,
    metadata: {
      callId: record.callId,
      toolName: record.toolName,
      outputPresent: record.outputSummary !== undefined,
    },
  }));
}

function toolStatus(result: ToolResult): ToolInvocationRecord['status'] {
  if (result.ok) return 'succeeded';
  const error = result.error?.toLowerCase() ?? '';
  if (error.includes('unknown tool')) return 'unknown_tool';
  if (error.includes('approval unavailable')) return 'approval_unavailable';
  if (error.includes('denied') || error.includes('approval')) return 'approval_denied';
  if (error.includes('timed out') || error.includes('timeout')) return 'timed_out';
  if (error.includes('abort') || error.includes('cancel')) return 'aborted';
  if (error.includes('repeated identical call')) return 'repeated_call_blocked';
  return 'failed';
}

function approvalRecord(status: ToolInvocationRecord['status']): ToolInvocationRecord['approval'] {
  if (status === 'approval_denied') return { required: true, decision: 'denied' };
  if (status === 'approval_unavailable') return { required: true, decision: 'unavailable' };
  return { required: 'unknown', decision: 'unknown' };
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return typeof input;
  const keys = Object.keys(input as Record<string, unknown>).slice(0, 20);
  return keys.length > 0 ? `object keys: ${keys.join(', ')}` : 'empty object';
}

function hashJson(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '[undefined]';
  } catch {
    serialized = '[non-serializable]';
  }
  return createHash('sha256').update(serialized).digest('hex');
}
