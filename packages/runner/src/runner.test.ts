// @littlesheep/runner — runner.test.ts
// E2E test: real SessionManager + MemoryStore + mock LlmClient.
// Validates createRunner run wiring + inbound persistence order.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from './runner.js';
import type { LlmClient, ChatRequest, ChatResponse, StreamChunk } from '@littlesheep/llm';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING, dataSubdirs } from '@littlesheep/branding';

// ─── Mock LlmClient ─────────────────────────────────────────────────────

type Responder = ChatResponse | ChatResponse[] | ((req: ChatRequest) => ChatResponse);

/** Build a mock LlmClient with queue/single/function responder. */
function makeMockLlm(responder: Responder): LlmClient {
  let queue: ChatResponse[] | null = null;
  let single: ChatResponse | null = null;
  let fn: ((req: ChatRequest) => ChatResponse) | null = null;
  if (Array.isArray(responder)) queue = [...responder];
  else if (typeof responder === 'function') fn = responder;
  else single = responder;

  const fallback: ChatResponse = { content: '', toolCalls: [], finishReason: 'stop' };
  const chat = vi.fn(async (_req: ChatRequest): Promise<ChatResponse> => {
    if (fn) return fn(_req);
    if (queue) return queue.shift() ?? fallback;
    return single ?? fallback;
  });
  const chatStream = vi.fn(async (
    req: ChatRequest,
    onDelta: (chunk: StreamChunk) => void,
  ): Promise<ChatResponse> => {
    const res = await chat(req);
    for (const delta of res.content.match(/.{1,3}/g) ?? []) {
      onDelta({ type: 'delta', delta });
    }
    onDelta({ type: 'done', finishReason: res.finishReason });
    return res;
  });
  const embed = vi.fn(async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } }));
  return { chat, chatStream, embed };
}

/** Build a text-only ChatResponse. */
function textResponse(
  content: string,
  finishReason: ChatResponse['finishReason'] = 'stop',
): ChatResponse {
  return { content, toolCalls: [], finishReason };
}

// ─── Setup ─────────────────────────────────────────────────────────────

let dataDir: string;

// Track created runners so afterEach can call shutdown() — this closes the
// VectorStore's SQLite DB handle, preventing Windows EPERM on rmSync.
const createdRunners: Array<{ shutdown: () => Promise<void> }> = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ls-run-'));
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  createdRunners.length = 0;
});

afterEach(async () => {
  for (const r of createdRunners) {
    try { await r.shutdown(); } catch { /* best-effort */ }
  }
  delete process.env.LITTLESHEEP_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('createRunner run', () => {
  it('chat path: "hello" → ok + reply + correct trace', async () => {
    const llm = makeMockLlm(textResponse('Hello!'));
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);
    const result = await runner.run({ text: 'hello' });
    expect(result.status).toBe('ok');
    expect(result.reply).toBe('Hello!');
    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
    expect(result.memoryAccess?.records.map((record) => record.action)).toEqual(['root_index']);
    expect(result.memoryAccess?.endedAt).toBeTruthy();
    expect(runner.infra.registry.names()).toEqual(expect.arrayContaining(['memory_tree', 'memory_search']));
    expect(runner.infra.registry.names()).not.toContain('memory_deep_search');
    const replyRequest = (llm.chat as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as ChatRequest;
    expect(String(replyRequest.messages[0]?.content)).toContain('Memory Tree Root Index');
    const trace = result.trace as Array<{ name: string }>;
    expect(trace.map((t) => t.name)).toEqual(['enter', 'classify', 'reply', 'finalize']);
  });

  it('applies the coding behavior profile without changing tool permission policy', async () => {
    const requests: ChatRequest[] = [];
    const llm = makeMockLlm((request) => {
      requests.push(request);
      return textResponse('profiled reply');
    });
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);

    await runner.run({ text: 'hello', profile: 'coding' });

    const systemPrompt = String(requests.at(-1)?.messages[0]?.content ?? '');
    expect(systemPrompt).toContain('Behavior Profile: Coding');
    expect(systemPrompt).toContain('never grants tool permission');
  });

  it('creates a session when sessionId is undefined', async () => {
    const llm = makeMockLlm(textResponse('Hi'));
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);
    const r1 = await runner.run({ text: 'hello' });
    expect(r1.sessionId).toBeTruthy();
    expect(runner.state.sessionId).toBe(r1.sessionId);
  });

  it('runStream emits assistant deltas and returns the final reply', async () => {
    const llm = makeMockLlm(textResponse('Hello stream!'));
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);
    const deltas: string[] = [];
    const result = await runner.runStream({ text: 'hello' }, (delta) => deltas.push(delta));
    expect(result.status).toBe('ok');
    expect(result.reply).toBe('Hello stream!');
    expect(deltas.join('')).toBe('Hello stream!');
  });

  it('forwards image attachments to the LLM request', async () => {
    const seen: ChatRequest[] = [];
    const llm = makeMockLlm((req) => {
      seen.push(req);
      return textResponse('I can see it.');
    });
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);
    const result = await runner.run({
      text: 'describe this image',
      attachments: [{
        path: 'C:\\tmp\\image.png',
        name: 'image.png',
        kind: 'image',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,abc',
      }],
    });
    expect(result.status).toBe('ok');
    const lastMessage = seen.at(-1)?.messages.at(-1);
    expect(Array.isArray(lastMessage?.content)).toBe(true);
    expect(lastMessage?.content).toContainEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,abc', detail: 'auto' },
    });
  });

  it('continues an existing session when sessionId is passed', async () => {
    const llm = makeMockLlm([textResponse('First'), textResponse('Second')]);
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);
    const r1 = await runner.run({ text: 'hello' });
    const sid = r1.sessionId;
    const r2 = await runner.run({ sessionId: sid, text: 'bye' });
    expect(r2.sessionId).toBe(sid);
  });

  it('aborted signal → status="aborted"', async () => {
    const llm = makeMockLlm(textResponse('never mind'));
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);
    const ac = new AbortController();
    ac.abort();
    const result = await runner.run({ text: 'hello', signal: ac.signal });
    expect(result.status).toBe('aborted');
  });

  it('persists inbound + produced in JSONL [user, assistant] order', async () => {
    const llm = makeMockLlm(textResponse('Reply body'));
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);
    const result = await runner.run({ text: 'hello' });
    const sid = result.sessionId;
    const sessionsDir = dataSubdirs(DEFAULT_BRANDING).sessions;
    const file = join(sessionsDir, `${sid}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    // Skip metadata header (first line) — verify message order.
    const messages = lines.slice(1).map((l) => JSON.parse(l) as { role?: string });
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  // ─── M3: execution log persistence + replay ────────────────────────────

  it('run 写入 execution log，replay(runId) 返回完整内容', async () => {
    const llm = makeMockLlm(textResponse('Hello!'));
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);
    const result = await runner.run({ text: 'hello' });
    const log = await runner.replay(result.runId);
    expect(log).not.toBeNull();
    expect(log!.runId).toBe(result.runId);
    expect(log!.sessionId).toBe(result.sessionId);
    expect(log!.reply).toBe('Hello!');
    expect(log!.inboundText).toBe('hello');
    expect(log!.trace).toEqual(result.trace);
    expect(log!.status).toBe('ok');
    expect(log!.model).toBe('test/model');
    expect(log!.memoryAccess).toEqual(result.memoryAccess);
  });

  it('replay 不存在的 runId → null', async () => {
    const llm = makeMockLlm(textResponse('hi'));
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);
    const log = await runner.replay('nonexistent-run-id');
    expect(log).toBeNull();
  });

  it('execution log 文件物理存在于 execution-logs 目录', async () => {
    const llm = makeMockLlm(textResponse('Reply'));
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);
    const result = await runner.run({ text: 'hello' });
    const execLogDir = dataSubdirs(DEFAULT_BRANDING).executionLogs;
    const file = join(execLogDir, `${result.runId}.json`);
    expect(existsSync(file)).toBe(true);
  });

  it('persists EVOLVE and CAPTURE output through the same indexed memory runtime', async () => {
    const llm = makeMockLlm([
      textResponse('{"type":"problem","confidence":0.9,"reason":"task"}'),
      textResponse('{"plan":[{"description":"inspect it","tools":[]}]}'),
      textResponse('Inspection complete.'),
      textResponse('{"verdict":"pass","reason":"goal achieved"}'),
      textResponse(JSON.stringify({ memories: [{
        branch: 'project', parentNodeId: 'project:root', scope: 'workspace',
        summary: 'Repository uses pnpm', content: 'Use pnpm commands in this workspace.',
        retrievalKeys: ['pnpm', 'workspace'], importance: 0.8, confidence: 0.95,
        reason: 'Verified from the repository configuration.',
      }], createSkill: null })),
      textResponse(JSON.stringify({ observations: [{
        summary: 'Inspection completed', content: 'The requested repository inspection completed successfully.',
        retrievalKeys: ['inspection', 'completed'], importance: 0.4, confidence: 0.9,
        reason: 'Useful for reconstructing this run.',
      }] })),
    ]);
    const runner = await createRunner({ config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING, model: 'test/model', llm });
    createdRunners.push(runner);
    const result = await runner.run({ text: 'read the file', cwd: 'D:/test-project' });

    expect(result.status).toBe('ok');
    const projectNodes = await runner.infra.memoryRepository.listNodes('project', 'D:/test-project');
    const dailyNodes = await runner.infra.memoryRepository.listNodes('daily', 'D:/test-project');
    expect(projectNodes).toHaveLength(1);
    expect(projectNodes[0]).toMatchObject({ summary: 'Repository uses pnpm', sourceRunIds: [result.runId] });
    expect(dailyNodes).toHaveLength(1);
    expect(dailyNodes[0]).toMatchObject({ summary: 'Inspection completed', sourceRunIds: [result.runId] });
    expect((await runner.infra.memoryRepository.snapshot()).writeAudit.map((record) => record.decision)).toEqual(['created', 'created']);
  });

  // ─── Phase 3: channel meta binding ───────────────────────────────────

  it('origin=channel + channelId stamps metadata for listByChannel', async () => {
    const llm = makeMockLlm(textResponse('ok'));
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);
    const result = await runner.run({
      text: 'from telegram',
      origin: 'channel',
      channelId: 'tg-bot-1',
      externalConversationId: 'chat-42',
    });
    // Metadata should carry channelId + origin + externalConversationId.
    const meta = await runner.sessionManager.loadMetadata(result.sessionId);
    expect(meta?.channelId).toBe('tg-bot-1');
    expect(meta?.origin).toBe('channel');
    expect(meta?.externalConversationId).toBe('chat-42');
    // listByChannel should find it.
    const ids = await runner.sessionManager.listByChannel('tg-bot-1');
    expect(ids).toContain(result.sessionId);
  });

  it('origin=app stamps origin in metadata', async () => {
    const llm = makeMockLlm(textResponse('ok'));
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);
    const result = await runner.run({ text: 'local', origin: 'app' });
    const meta = await runner.sessionManager.loadMetadata(result.sessionId);
    expect(meta?.origin).toBe('app');
    expect(meta?.channelId).toBeUndefined();
  });
});
