// @littlesheep/runner — runner.test.ts
// E2E test: real SessionManager + MemoryStore + mock LlmClient.
// Validates createRunner run wiring + inbound persistence order.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from './runner.js';
import type { LlmClient, ChatRequest, ChatResponse, StreamChunk } from '@littlesheep/llm';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING, dataSubdirs } from '@littlesheep/branding';
import { textMessage, type AgentTool } from '@littlesheep/types';
import { attachmentManifestResourceId, attachmentResourceId } from '@littlesheep/memory-tree';
import { reduceDurableRunProjection } from '@littlesheep/harness';

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
  it('registers stable bootstrap authorities when the runner starts', async () => {
    writeFileSync(join(dataDir, 'AGENTS.md'), 'Verify every completed task.', 'utf8');
    writeFileSync(join(dataDir, 'SOUL.md'), 'Calm and factual.', 'utf8');
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('unused')),
      bootstrapDir: dataDir,
      skillsDirs: [],
    });
    createdRunners.push(runner);
    const resources = await runner.infra.memoryService.listResources();
    expect(resources.filter((resource) => resource.registryGroup.startsWith('bootstrap:'))).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'AGENTS.md', tier: 0, status: 'active' }),
      expect.objectContaining({ title: 'SOUL.md', tier: 0, status: 'active' }),
      expect.objectContaining({ title: 'USER.md', tier: 1, status: 'missing' }),
      expect.objectContaining({ title: 'PHILOSOPHY.md', kind: 'philosophy', tier: 1, status: 'missing' }),
    ]));
  });

  it('defers external workspace indexing in research and indexes immediately in full access', async () => {
    const containerRoot = join(dataDir, 'container');
    const externalWorkspace = join(dataDir, 'external-workspace');
    mkdirSync(containerRoot, { recursive: true });
    mkdirSync(externalWorkspace, { recursive: true });
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('workspace acknowledged')),
      bootstrapDir: containerRoot,
      containerRoot,
      skillsDirs: [],
    });
    createdRunners.push(runner);
    const syncResources = vi.spyOn(runner.infra.memoryService, 'syncWorkspaceResources');
    const syncDocuments = vi.spyOn(runner.infra.memoryService, 'syncWorkspaceDocuments');

    await runner.run({
      text: 'inspect the external workspace',
      cwd: externalWorkspace,
      permissionPolicyId: 'research',
    });

    expect(syncResources).not.toHaveBeenCalled();
    expect(syncDocuments).not.toHaveBeenCalled();

    await runner.run({
      text: 'continue in full access',
      cwd: externalWorkspace,
      permissionPolicyId: 'full',
    });

    expect(syncResources).toHaveBeenCalledWith(externalWorkspace, undefined);
    expect(syncDocuments).toHaveBeenCalledWith(externalWorkspace);
  });

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
    expect(result.memoryAccess?.records[0]?.action).toBe('root_index');
    expect(result.memoryAccess?.records.slice(1)).toHaveLength(4);
    expect(result.memoryAccess?.records.slice(1).every((record) => (
      record.action === 'branch_index'
      && record.tokensUsed === 0
      && record.fragmentIds.length === 0
    ))).toBe(true);
    expect(result.memoryAccess?.records.some((record) => record.action === 'expand')).toBe(false);
    expect(result.memoryAccess?.endedAt).toBeTruthy();
    expect(runner.infra.registry.names()).toEqual(expect.arrayContaining([
      'memory_tree',
      'memory_search',
      'memory_deep_search',
    ]));
    const replyRequest = (llm.chat as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as ChatRequest;
    expect(String(replyRequest.messages[0]?.content)).toContain('Memory Tree Root Index');
    const trace = result.trace as Array<{ name: string }>;
    expect(trace.map((t) => t.name)).toEqual(['enter', 'classify', 'reply', 'finalize']);
  });

  it('next durable Harness drives an independent transition path and replays one settlement', async () => {
    const llm = makeMockLlm(textResponse('Next path reply'));
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      durableHarnessMode: 'next',
    });
    createdRunners.push(runner);

    const result = await runner.run({ text: 'hello' });
    expect(result.status).toBe('ok');
    expect(result.reply).toBe('Next path reply');
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(result.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);

    const events = await runner.infra.durableEventStore.read(String(result.sessionId), result.runId);
    expect(events.filter((event) => event.type === 'stage_transition_recorded').length).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === 'final_reply_settled')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('run_completed');
    const projection = reduceDurableRunProjection(events);
    expect(projection.status).toBe('completed');
    expect(projection.finalReply.state).toBe('settled');
    expect(projection.stageTransitions.map((transition) => transition.stage)).toEqual(
      result.trace.map((transition) => transition.name),
    );
  });

  it('rewrites an exact reply from older session history after runner restart', async () => {
    const firstRunner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('Stable exact reply')),
    });
    createdRunners.push(firstRunner);
    const first = await firstRunner.run({ text: 'hello' });
    expect(first.reply).toBe('Stable exact reply');

    const filler = Array.from({ length: 24 }, (_, index) => textMessage(
      index % 2 === 0 ? 'user' : 'assistant',
      `filler-${index}`,
      { sessionId: first.sessionId },
    ));
    await firstRunner.infra.sessionManager.append(first.sessionId, filler);
    await firstRunner.shutdown();
    createdRunners.pop();

    const restarted = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm((request) => textResponse(
        String(request.messages[0]?.content).includes('Regeneration contract')
          ? 'Fresh wording after restart'
          : 'Stable exact reply',
      )),
    });
    createdRunners.push(restarted);

    const second = await restarted.run({
      text: 'hello again',
      sessionId: first.sessionId,
    });

    expect(second.status).toBe('ok');
    expect(second.reply).toBe('Fresh wording after restart');
    expect(second.replyProvenance?.rewriteCount).toBe(1);
    expect(second.modelRequests?.some((request) => (
      request.id === second.replyProvenance?.modelRequestId
      && request.requestIndex === second.replyProvenance?.modelRequestIndex
      && request.provider === second.replyProvenance?.provider
      && request.model === second.replyProvenance?.model
    ))).toBe(true);
  });

  it('returns reply-call token usage with an explicit provider source', async () => {
    const llm = makeMockLlm({
      ...textResponse('Hello with usage!'),
      usage: { promptTokens: 240, completionTokens: 12, totalTokens: 252 },
    });
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);

    const result = await runner.run({ text: 'hello' });

    expect(result.usage).toEqual({
      promptTokens: 240,
      completionTokens: 12,
      totalTokens: 252,
      source: 'provider',
    });
    expect(result.contextSnapshots?.find((snapshot) => snapshot.providerUsage)?.providerUsage).toMatchObject({
      source: 'provider',
      provider: 'test',
      model: 'model',
      promptTokens: 240,
      completionTokens: 12,
      totalTokens: 252,
    });
  });

  it('scopes additional tools to one run without mutating the shared registry', async () => {
    const llm = makeMockLlm(textResponse('Attachment acknowledged.'));
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);
    const inspectTool: AgentTool = {
      name: 'inspect_attachment',
      description: 'Inspect a selected attachment.',
      inputSchema: {
        parse: (input) => input,
        jsonSchema: { type: 'object' },
      },
      async execute() {
        return { callId: '', ok: true, output: 'content' };
      },
    };

    const result = await runner.run({
      text: 'hello',
      additionalTools: [inspectTool],
    });

    expect(result.resolvedRunConfig?.availableToolNames).toContain('inspect_attachment');
    expect(runner.infra.registry.names()).not.toContain('inspect_attachment');
  });

  it('preserves plugin and run-scoped tool sources in authoritative execution records', async () => {
    const toolResponse: ChatResponse = {
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [
        { id: 'plugin-call', type: 'function', function: { name: 'plugin_probe', arguments: '{}' } },
        { id: 'run-call', type: 'function', function: { name: 'run_probe', arguments: '{}' } },
      ],
    };
    const llm = makeMockLlm([
      textResponse('{"type":"problem","confidence":0.99,"reason":"execute probes"}'),
      textResponse('{"plan":[{"description":"run both probes","tools":["plugin_probe","run_probe"]}]}'),
      toolResponse,
      textResponse('Both probes completed.'),
      textResponse('Probe execution completed successfully.'),
      textResponse('{"verdict":"pass","reason":"both probes completed"}'),
      textResponse('{"memories":[],"createSkill":null}'),
      textResponse('{"observations":[]}'),
    ]);
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);
    const calls: string[] = [];
    const probe = (name: string): AgentTool => ({
      name,
      description: `${name} test tool`,
      inputSchema: { parse: (input) => input, jsonSchema: { type: 'object' } },
      execution: { concurrency: 'parallel', resources: () => [{ key: `probe:${name}`, mode: 'read' }] },
      async execute() {
        calls.push(name);
        return { callId: '', ok: true, output: `${name}:ok` };
      },
    });
    runner.infra.registry.register(probe('plugin_probe'), 'plugin:test-provider');

    const result = await runner.run({
      text: 'run both probes',
      additionalTools: [probe('run_probe')],
    });
    const replay = await runner.replay(result.runId);

    expect(result.status).toBe('ok');
    expect(calls).toEqual(expect.arrayContaining(['plugin_probe', 'run_probe']));
    expect(result.toolInvocations?.map((record) => [record.toolName, record.toolSource])).toEqual([
      ['plugin_probe', 'plugin:test-provider'],
      ['run_probe', 'run-scoped'],
    ]);
    expect(replay?.toolInvocations).toEqual(result.toolInvocations);
  });

  it('seals intermediate side-effect checkpoints when the source run finishes successfully', async () => {
    const toolResponse: ChatResponse = {
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [
        { id: 'checkpoint-write-call', type: 'function', function: { name: 'checkpoint_write', arguments: '{}' } },
      ],
    };
    const llm = makeMockLlm([
      textResponse('{"type":"problem","confidence":0.99,"reason":"execute checkpoint write"}'),
      textResponse('{"plan":[{"description":"write checkpoint proof","tools":["checkpoint_write"]}]}'),
      toolResponse,
      textResponse('Checkpoint write completed.'),
      textResponse('Checkpoint proof was written successfully.'),
      textResponse('{"verdict":"pass","reason":"checkpoint proof exists"}'),
      textResponse('{"memories":[],"createSkill":null}'),
      textResponse('{"observations":[]}'),
    ]);
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);
    const checkpointWrite: AgentTool = {
      name: 'checkpoint_write',
      description: 'Create a checkpointed test mutation.',
      inputSchema: { parse: (input) => input, jsonSchema: { type: 'object' } },
      execution: {
        concurrency: 'exclusive',
        resources: () => [{ key: 'workspace:checkpoint-proof', mode: 'write' }],
      },
      async execute() {
        return { callId: '', ok: true, output: 'checkpoint-proof' };
      },
    };

    const result = await runner.run({
      runId: 'successful-checkpoint-source',
      text: 'write checkpoint proof',
      additionalTools: [checkpointWrite],
    });

    expect(result.status).toBe('ok');
    expect(result.runCheckpointId).toEqual(expect.any(String));
    expect(await runner.infra.runCheckpointDispositionStore.read(result.runCheckpointId!)).toMatchObject({
      status: 'completed',
      resultStatus: 'ok',
    });
    expect((await runner.runCheckpoints!.inspect(result.runCheckpointId!))?.resumable).toBe(false);
  });

  it('registers attachment metadata for the run without persisting payloads and replaces it next run', async () => {
    const llm = makeMockLlm(textResponse('Attachment acknowledged.'));
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);
    const runId = 'run-attachment-registry';
    const result = await runner.run({
      runId,
      text: 'hello',
      attachments: [{
        id: 'attachment-notes',
        path: 'D:/private/notes.md',
        name: 'notes.md',
        kind: 'document',
        dataUrl: 'data:text/plain;base64,PRIVATE-RUN-DATA',
        extractedText: 'PRIVATE-RUN-BODY',
        contentHash: 'a'.repeat(64),
        contentState: 'loaded',
        ownership: 'external',
      }],
    });
    const manifestId = attachmentManifestResourceId(runId);
    const attachmentId = attachmentResourceId(runId, 'attachment-notes');
    const resourceSnapshot = await runner.infra.memoryRepository.snapshot();
    expect(resourceSnapshot.resources[manifestId]).toMatchObject({ kind: 'attachment-manifest', scope: 'run' });
    expect(resourceSnapshot.resources[attachmentId]).toMatchObject({
      kind: 'attachment',
      scopeKey: runId,
      metadata: { contentHash: 'a'.repeat(64) },
    });
    expect(JSON.stringify(resourceSnapshot)).not.toContain('PRIVATE-RUN-DATA');
    expect(JSON.stringify(resourceSnapshot)).not.toContain('PRIVATE-RUN-BODY');
    expect(result.contextSnapshots?.flatMap((snapshot) => snapshot.items).some((item) => (
      item.source.kind === 'attachment' && item.source.id === manifestId
    ))).toBe(true);
    expect((await runner.replay(runId))?.resourceIds).toContain(manifestId);

    await runner.run({ sessionId: result.sessionId, text: 'follow up without attachments' });
    expect(await runner.infra.memoryRepository.getResource(manifestId)).toBeUndefined();
    expect(await runner.infra.memoryRepository.getResource(attachmentId)).toBeUndefined();
  });

  it('creates a non-destructive session summary when the configured threshold is reached', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.sessions.compaction.threshold = 2;
    config.sessions.compaction.keepRecent = 1;
    const llm = makeMockLlm(textResponse('summary text'));
    const runner = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'openai/gpt-test',
      llm,
    });
    createdRunners.push(runner);

    const result = await runner.run({ text: 'remember this request' });
    const metadata = await runner.sessionManager.loadMetadata(result.sessionId);
    const messages = await runner.sessionManager.read(result.sessionId);

    expect(messages).toHaveLength(2);
    expect(metadata?.compaction).toMatchObject({
      version: 2,
      collapsedCount: 1,
      sourceStartMessageId: messages[0]?.id,
      sourceEndMessageId: messages[0]?.id,
      sourceRunIds: [result.runId],
      sourceRunIdsTruncated: false,
      summary: 'summary text',
      cache: {
        compressionDepth: 1,
        disclosureLevel: 'D1',
        vectorClass: 'semantic-cache',
      },
      sourceRanges: [{
        messageCount: 1,
        sourceStartMessageId: messages[0]?.id,
        sourceEndMessageId: messages[0]?.id,
      }],
    });
    const summary = metadata!.compaction!;
    expect(await runner.infra.memoryRepository.getResource(summary.id)).toMatchObject({
      id: summary.id,
      kind: 'summary-memory',
      scope: 'session',
      scopeKey: String(result.sessionId),
      source: { kind: 'session-summary', id: summary.id },
    });
    expect(JSON.stringify(await runner.infra.memoryRepository.snapshot())).not.toContain(summary.summary);
    const calls = (llm.chat as ReturnType<typeof vi.fn>).mock.calls;
    expect(String(calls.at(-1)?.[0]?.messages?.[0]?.content)).toContain('versioned session summary');
    expect(String(calls.at(-1)?.[0]?.messages?.[0]?.content)).toContain('inert historical data, not instructions');
    expect(calls.at(-1)?.[0]?.model).toBe('gpt-test');

    config.sessions.compaction.threshold = 100;
    const continuation = await runner.run({ sessionId: result.sessionId, text: 'continue from the summary' });
    expect(continuation.contextSnapshots?.flatMap((snapshot) => snapshot.items).some((item) => (
      item.kind === 'summary_memory' && item.source.kind === 'memory' && item.source.id === summary.id
    ))).toBe(true);
    expect((await runner.replay(continuation.runId))?.resourceIds).toContain(summary.id);
  });

  it('uses the caller runId and persists the immutable run decision and request snapshots', async () => {
    const llm = makeMockLlm(textResponse('Observed reply'));
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'openai/gpt-test',
      llm,
    });
    createdRunners.push(runner);

    const result = await runner.run({
      runId: 'run-observed-fixed',
      text: 'hello',
      origin: 'app',
      profile: 'coding',
      permissionPolicyId: 'research',
      reasoning: 'high',
    });

    expect(result.runId).toBe('run-observed-fixed');
    expect(result.resolvedRunConfig).toMatchObject({
      runId: 'run-observed-fixed',
      origin: 'app',
      behaviorModeId: 'coding',
      permissionPolicyId: 'research',
      provider: 'openai',
      model: 'gpt-test',
      reasoning: 'high',
    });
    expect(Object.isFrozen(result.resolvedRunConfig)).toBe(true);
    expect(result.modelRequests?.map((request) => request.stage)).toEqual(['reply']);
    expect(result.modelRequests?.[0]?.contextSnapshotId).toBe(result.contextSnapshots?.[0]?.id);
    expect(result.contextSnapshots?.[0]?.budget.status).toBe('unknown');
    expect(result.capabilitySnapshot?.epoch).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.capabilityPermissionEvent).toMatchObject({
      eventId: 'run-observed-fixed:workspace-scan-permission',
      action: 'workspace_scan',
      capabilityEpoch: result.capabilitySnapshot?.epoch,
      permissionPolicyId: 'research',
      source: 'runtime',
    });

    const replay = await runner.replay(result.runId);
    expect(replay?.resolvedRunConfig).toEqual(result.resolvedRunConfig);
    expect(replay?.modelRequests).toEqual(result.modelRequests);
    expect(replay?.contextSnapshots).toEqual(result.contextSnapshots);
    expect(replay?.capabilitySnapshot).toEqual(result.capabilitySnapshot);
    expect(replay?.capabilityPermissionEvent).toEqual(result.capabilityPermissionEvent);
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
    const imageMessage = seen
      .flatMap((request) => request.messages)
      .find((message) => Array.isArray(message.content)
        && message.content.some((part) => part.type === 'image_url'));
    expect(Array.isArray(imageMessage?.content)).toBe(true);
    expect(imageMessage?.content).toContainEqual({
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

  it('routes an active-run interrupt through the bounded queue and stops at the next safe boundary', async () => {
    const llm = makeMockLlm(textResponse('reply before boundary'));
    let releaseResponse!: () => void;
    let markCallStarted!: () => void;
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const callStarted = new Promise<void>((resolve) => { markCallStarted = resolve; });
    (llm.chat as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      markCallStarted();
      await responseGate;
      return textResponse('reply before boundary');
    });
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);
    const runId = 'run-runtime-interrupt';
    const running = runner.run({ runId, text: 'hello' });
    await callStarted;

    expect(runner.runtimeEvents.summary(runId)).toMatchObject({ queued: 0 });
    expect(runner.runtimeEvents.append(runId, {
      type: 'interrupt_requested',
      source: 'app',
      payload: { reason: 'user requested stop' },
      dedupKey: 'interrupt:1',
    })).toMatchObject({ kind: 'accepted', event: { runId, sequence: 1 } });
    releaseResponse();

    const result = await running;
    expect(result.status).toBe('aborted');
    expect(result.runtimeControl).toMatchObject({
      state: 'interrupted',
      reason: 'user requested stop',
      eventIds: [expect.any(String)],
    });
    expect(result.runtimeEventQueue).toMatchObject({
      runId,
      cursor: 1,
      events: [expect.objectContaining({ type: 'interrupt_requested', status: 'applied' })],
    });
    expect(runner.runtimeEvents.summary(runId)).toBeNull();
    const checkpoint = await runner.infra.runCheckpointStore?.latestForRun(runId);
    expect(checkpoint).toMatchObject({
      runId,
      status: 'recoverable',
      currentStage: expect.any(String),
      runtimeControl: { state: 'interrupted' },
      runtimeEventQueue: {
        runId,
        events: [expect.objectContaining({ type: 'interrupt_requested', status: 'applied' })],
      },
    });
    expect((await runner.replay(runId))).toMatchObject({
      runtimeControl: { state: 'interrupted' },
      runCheckpointId: checkpoint?.id,
    });
  });

  it('freezes a paused run as a resumable paused checkpoint instead of a failure', async () => {
    const llm = makeMockLlm(textResponse('reply before pause boundary'));
    let releaseResponse!: () => void;
    let markCallStarted!: () => void;
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const callStarted = new Promise<void>((resolve) => { markCallStarted = resolve; });
    (llm.chat as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      markCallStarted();
      await responseGate;
      return textResponse('reply before pause boundary');
    });
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);
    const runId = 'run-runtime-pause';
    const running = runner.run({ runId, text: 'hello' });
    await callStarted;

    expect(runner.activeRuns?.request(runId, 'pause', 'user requested pause')).toMatchObject({
      kind: 'accepted',
      run: { controlStatus: 'pause_requested' },
    });
    releaseResponse();

    const result = await running;
    expect(result.status).toBe('aborted');
    expect(result.runtimeControl).toMatchObject({
      state: 'paused',
      reason: 'user requested pause',
    });
    const checkpoint = await runner.infra.runCheckpointStore?.latestForRun(runId);
    expect(checkpoint).toMatchObject({
      runId,
      status: 'paused',
      runtimeControl: { state: 'paused' },
    });
    expect((await runner.replay(runId))).toMatchObject({
      status: 'aborted',
      runtimeControl: { state: 'paused' },
      runCheckpointId: checkpoint?.id,
    });
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

  it('persists a bounded last-run summary for immediate follow-up context', async () => {
    const requests: ChatRequest[] = [];
    const llm = makeMockLlm((request) => {
      requests.push(request);
      return textResponse('Hello!');
    });
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);

    const first = await runner.run({ text: 'hello' });
    const summary = await runner.infra.executionLogStore.readLatestForSession(first.sessionId);
    expect(summary).toMatchObject({
      version: 1,
      runId: first.runId,
      status: 'ok',
      durationMs: expect.any(Number),
      tools: { total: 0, succeeded: 0, failed: 0, truncated: false },
    });

    const requestCount = requests.length;
    await runner.run({ sessionId: first.sessionId, text: 'what was the status of the previous run?' });
    const followUpRequests = requests.slice(requestCount);
    expect(followUpRequests.some((request) => (
      String(request.messages.find((message) => message.role === 'system')?.content)
        .includes(`previous_run: id=${first.runId}`)
    ))).toBe(true);
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
      textResponse('Inspection completed successfully.'),
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
    expect(dailyNodes[0]).toMatchObject({ summary: 'Run done: read the file', sourceRunIds: [result.runId] });
    expect((await runner.infra.memoryRepository.snapshot()).writeAudit.map((record) => record.decision)).toEqual(['created', 'created']);
    expect(result.modelRequests?.map((request) => request.stage)).toEqual([
      'classify',
      'decide',
      'execute',
      'execute',
      'verify',
      'evolve',
    ]);
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
