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

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
  Message,
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
} from '@littlesheep/types';
import type { MemoryAccessLedger } from '@littlesheep/memory-tree';

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
  error?: string;
  trace: StageTraceEntry[];
  taskExecution?: TaskExecutionResult;
  taskBook?: TaskBook;
  verificationHistory?: VerificationRecord[];
  clarificationRequest?: ClarificationRequest;
  clarificationResponse?: ClarificationResponse;
  memoryAccess?: MemoryAccessLedger;
  resolvedRunConfig?: ResolvedRunConfig;
  modelRequests?: ModelRequestSnapshot[];
  contextSnapshots?: ContextSnapshot[];
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
  error?: string;
  trace: StageTraceEntry[];
  taskExecution?: TaskExecutionResult;
  taskBook?: TaskBook;
  verificationHistory?: VerificationRecord[];
  clarificationRequest?: ClarificationRequest;
  clarificationResponse?: ClarificationResponse;
  memoryAccess?: MemoryAccessLedger;
  resolvedRunConfig?: ResolvedRunConfig;
  modelRequests?: ModelRequestSnapshot[];
  contextSnapshots?: ContextSnapshot[];
  messages: Message[];
  durationMs: number;
}

export interface ExecutionLogStoreOptions {
  /** Directory for execution log files. */
  rootDir: string;
}

export class ExecutionLogStore {
  private readonly rootDir: string;

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
    const resources = collectResourceIds(input);
    const log: ExecutionLog = {
      runId: input.runId,
      sessionId: input.sessionId,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      status: input.status,
      model: input.model,
      inboundText: input.inboundText,
      reply: input.reply,
      error: input.error,
      trace: input.trace,
      taskExecution: input.taskExecution,
      taskBook: input.taskBook ? { ...input.taskBook, stageResults: undefined } : undefined,
      verificationHistory: input.verificationHistory,
      clarificationRequest: input.clarificationRequest,
      clarificationResponse: input.clarificationResponse,
      memoryAccess: input.memoryAccess,
      resolvedRunConfig: input.resolvedRunConfig,
      modelRequests: input.modelRequests,
      contextSnapshots: input.contextSnapshots,
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

  /** List all runIds that have execution logs. */
  async list(): Promise<string[]> {
    if (!existsSync(this.rootDir)) return [];
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(this.rootDir);
    return entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  }
}

const MAX_TOOL_INVOCATIONS_PER_LOG = 256;
const MAX_RESOURCE_IDS_PER_LOG = 256;

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

function buildToolEvidence(
  input: ExecutionLogInput,
  pairs: ToolCallRecord[],
): { toolInvocations: ToolInvocationRecord[]; evidence: ExecutionEvidence[]; truncated: boolean } {
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
  const evidence = toolInvocations.map((record): ExecutionEvidence => ({
    version: 1,
    id: record.evidenceIds[0]!,
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
  return { toolInvocations, evidence, truncated: pairs.length > selected.length };
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
