// @littlesheep/harness — tests/helpers.ts
// Test utilities: mock LlmClient + minimal RunContext/AgentTool builders.

import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type {
  RunContext,
  AgentTool,
  ToolResult,
  ToolContext,
  Message,
  SessionId,
  SessionMetadata,
} from '@littlesheep/types';
import { normalizeUserFacingReply, textMessage } from '@littlesheep/types';
import type { LlmClient, ChatRequest, ChatResponse, EmbedRequest, EmbedResponse } from '@littlesheep/llm';

// ─── Mock LlmClient ─────────────────────────────────────────────────────

type Responder =
  | ChatResponse
  | ChatResponse[]
  | ((req: ChatRequest) => ChatResponse);

export interface MockLlm extends LlmClient {
  chat: ReturnType<typeof vi.fn>;
  chatStream: ReturnType<typeof vi.fn>;
  embed: ReturnType<typeof vi.fn>;
}

/** Build a mock LlmClient. Pass a single response (repeated), a queue, or a function. */
export function createMockLlm(responder: Responder): MockLlm {
  let queue: ChatResponse[] | null = null;
  let single: ChatResponse | null = null;
  let fn: ((req: ChatRequest) => ChatResponse) | null = null;
  if (Array.isArray(responder)) queue = [...responder];
  else if (typeof responder === 'function') fn = responder;
  else single = responder;

  const fallback: ChatResponse = { content: '', toolCalls: [], finishReason: 'stop' };

  const chat = vi.fn(async (req: ChatRequest): Promise<ChatResponse> => {
    if (fn) return fn(req);
    if (queue) return queue.shift() ?? fallback;
    return single ?? fallback;
  });
  const chatStream = vi.fn(async (req: ChatRequest) => chat(req));
  // Default embed: deterministic pseudo-embedding (8 dims) derived from input hash.
  // Tests that need real embeddings should override via mock.embed.mockImplementation.
  const embed = vi.fn(async (req: EmbedRequest): Promise<EmbedResponse> => {
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    const embeddings = inputs.map((text) => {
      // Simple deterministic hash → 8-dim vector (sufficient for structural tests).
      const vec = new Array(8).fill(0);
      for (let i = 0; i < text.length; i++) {
        vec[i % 8] = (vec[i % 8] + text.charCodeAt(i)) / 1000;
      }
      return vec;
    });
    return { embeddings, model: req.model, usage: { promptTokens: inputs.reduce((n, t) => n + t.length, 0) } };
  });
  return { chat, chatStream, embed };
}

/** Build a text-only ChatResponse. */
export function textResponse(
  content: string,
  finishReason: ChatResponse['finishReason'] = 'stop',
): ChatResponse {
  return { content, toolCalls: [], finishReason };
}

/** Build a tool_calls ChatResponse from simplified call descriptors. */
export function toolCallResponse(
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  content = '',
): ChatResponse {
  return {
    content,
    finishReason: 'tool_calls',
    toolCalls: calls.map((c) => ({
      id: c.id,
      type: 'function' as const,
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    })),
  };
}

// ─── RunContext builder ─────────────────────────────────────────────────

export interface MakeCtxOptions {
  sessionId?: SessionId;
  inbound?: Message;
  history?: Message[];
  tools?: AgentTool[];
  plan?: RunContext['plan'];
  needAssessment?: RunContext['needAssessment'];
  taskBook?: RunContext['taskBook'];
  clarificationRequest?: RunContext['clarificationRequest'];
  clarificationResponse?: RunContext['clarificationResponse'];
  classification?: RunContext['classification'];
  reply?: string;
  replyProvenance?: RunContext['replyProvenance'];
  modelRequests?: RunContext['modelRequests'];
  lastError?: RunContext['lastError'];
  recoveryAttempts?: number;
  maxRecoveryAttempts?: number;
  toolContext?: Partial<ToolContext>;
  attachments?: RunContext['attachments'];
  bootstrap?: Record<string, string>;
  produced?: Message[];
  initialMemoryContext?: string;
  sessionSummary?: RunContext['sessionSummary'];
  memoryKnownState?: RunContext['memoryKnownState'];
}

/** Build a minimal RunContext for stage unit tests. */
export function makeCtx(opts: MakeCtxOptions = {}): RunContext {
  const sessionId = (opts.sessionId ?? 'test-session') as SessionId;
  const runId = randomUUID();
  const modelRequests = opts.modelRequests ?? (opts.replyProvenance ? [{
    version: 1 as const,
    id: opts.replyProvenance.modelRequestId,
    runId,
    sessionId,
    stage: replyPurposeStage(opts.replyProvenance.purpose),
    requestIndex: opts.replyProvenance.modelRequestIndex,
    provider: opts.replyProvenance.provider,
    model: opts.replyProvenance.model,
    createdAt: opts.replyProvenance.generatedAt,
    messages: [],
    totalMessageCount: 0,
    messagesTruncated: false,
    toolNames: [],
    totalToolCount: 0,
    toolsTruncated: false,
    stream: false,
    callContract: {
      purpose: opts.replyProvenance.purpose,
    } as NonNullable<NonNullable<RunContext['modelRequests']>[number]['callContract']>,
  }] : undefined);
  return {
    runId,
    sessionId,
    inbound: opts.inbound ?? textMessage('user', 'hello'),
    cwd: process.cwd(),
    model: 'test-model',
    tools: opts.tools ?? [],
    toolContext: {
      sessionId,
      runId,
      cwd: process.cwd(),
      ...opts.toolContext,
    },
    history: opts.history ?? [],
    attachments: opts.attachments,
    produced: opts.produced ?? [],
    maxRecoveryAttempts: opts.maxRecoveryAttempts ?? 3,
    recoveryAttempts: opts.recoveryAttempts ?? 0,
    startedAt: new Date().toISOString(),
    bootstrap: opts.bootstrap,
    initialMemoryContext: opts.initialMemoryContext,
    sessionSummary: opts.sessionSummary,
    memoryKnownState: opts.memoryKnownState,
    needAssessment: opts.needAssessment,
    taskBook: opts.taskBook,
    clarificationRequest: opts.clarificationRequest,
    clarificationResponse: opts.clarificationResponse,
    plan: opts.plan,
    classification: opts.classification,
    reply: opts.reply,
    replyProvenance: opts.replyProvenance,
    modelRequests,
    lastError: opts.lastError,
  };
}

function replyPurposeStage(purpose: NonNullable<RunContext['replyProvenance']>['purpose']) {
  if (purpose === 'ask_user' || purpose === 'decide') return purpose;
  if (purpose === 'recover') return 'recover' as const;
  if (purpose === 'reply') return 'reply' as const;
  return 'execute' as const;
}

// ─── AgentTool builder ──────────────────────────────────────────────────

import { z } from 'zod';

/** Build a minimal AgentTool that records calls + returns a canned result. */
export function makeTool(
  name: string,
  result: Partial<ToolResult> & { ok: boolean },
  opts: { requiresApproval?: boolean; inputSchema?: z.ZodTypeAny } = {},
): AgentTool & { calls: Array<{ input: unknown; ctx: ToolContext }> } {
  const schema = opts.inputSchema ?? z.record(z.unknown());
  const calls: Array<{ input: unknown; ctx: ToolContext }> = [];
  return {
    name,
    description: `${name} tool (mock)`,
    inputSchema: schema,
    requiresApproval: opts.requiresApproval,
    async execute(input: unknown, ctx: ToolContext) {
      calls.push({ input, ctx });
      return {
        callId: '',
        ok: result.ok,
        output: result.output,
        error: result.error,
        durationMs: 1,
      };
    },
    // attach calls array on the tool object via a cast
    ...({ calls } as object),
  } as unknown as AgentTool & { calls: Array<{ input: unknown; ctx: ToolContext }> };
}

// ─── Mock SessionManager ─────────────────────────────────────────────────

import type { SessionManager } from '@littlesheep/session';

export interface MockSessionManager {
  readRecent: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
  reserveAssistantReply: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  loadMetadata: ReturnType<typeof vi.fn>;
  updateMetadata: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  sessionFile: ReturnType<typeof vi.fn>;
}

/**
 * Build a mock SessionManager. `appendThrows` verifies that persistence
 * failures do not block a completed run.
 */
export function createMockSessionManager(opts: {
  history?: Message[];
  appendThrows?: Error;
  metadata?: SessionMetadata | null;
} = {}): MockSessionManager {
  const reservedReplies = new Set(
    (opts.history ?? [])
      .filter((message) => message.role === 'assistant')
      .map((message) => message.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n'))
      .map(normalizeUserFacingReply)
      .filter(Boolean),
  );
  return {
    readRecent: vi.fn(async (_sid: SessionId, _n?: number) => opts.history ?? []),
    append: vi.fn(async (_sid: SessionId, _msgs: Message[]) => {
      if (opts.appendThrows) throw opts.appendThrows;
    }),
    reserveAssistantReply: vi.fn(async (_sid: SessionId, reply: string) => {
      const normalized = normalizeUserFacingReply(reply);
      if (!normalized || reservedReplies.has(normalized)) return false;
      reservedReplies.add(normalized);
      return true;
    }),
    read: vi.fn(async (_sid: SessionId) => opts.history ?? []),
    create: vi.fn(async () => ({ id: 'test-session' })),
    loadMetadata: vi.fn(async () => opts.metadata ?? null),
    updateMetadata: vi.fn(async () => undefined),
    load: vi.fn(async () => null),
    list: vi.fn(async () => []),
    stat: vi.fn(async () => null),
    sessionFile: vi.fn((_sid: SessionId) => ''),
  } as unknown as MockSessionManager;
}

// ─── Mock MemoryStore ─────────────────────────────────────────────────────

import type { MemoryStore } from '@littlesheep/memory-core';

export interface MockMemoryStore {
  appendLongTerm: ReturnType<typeof vi.fn>;
  appendDaily: ReturnType<typeof vi.fn>;
  readDaily: ReturnType<typeof vi.fn>;
  readLongTerm: ReturnType<typeof vi.fn>;
  writeLongTerm: ReturnType<typeof vi.fn>;
  writeDaily: ReturnType<typeof vi.fn>;
  listDailyDates: ReturnType<typeof vi.fn>;
  today: ReturnType<typeof vi.fn>;
  dailyFile: ReturnType<typeof vi.fn>;
  longTermPath: string;
  dailyDirPath: string;
}
/** Build a mock MemoryStore. All reads return empty; writes are no-ops. */
export function createMockMemoryStore(): MockMemoryStore {
  return {
    appendLongTerm: vi.fn(async (_entry: string) => undefined),
    appendDaily: vi.fn(async (_day: string, _entry: string) => undefined),
    readDaily: vi.fn(async (_day: string) => ''),
    readLongTerm: vi.fn(async () => ''),
    writeLongTerm: vi.fn(async (_content: string) => undefined),
    writeDaily: vi.fn(async (_day: string, _content: string) => undefined),
    listDailyDates: vi.fn(async () => []),
    today: vi.fn(() => '2026-06-29'),
    dailyFile: vi.fn((day: string) => `<tmp>/memory/${day}.md`),
    longTermPath: '<tmp>/MEMORY.md',
    dailyDirPath: '<tmp>/memory',
  } as unknown as MockMemoryStore;
}
