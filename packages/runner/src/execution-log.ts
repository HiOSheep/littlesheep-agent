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
  toolCalls: ToolCallRecord[];
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
      toolCalls: this.extractToolCallPairs(input.messages),
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
