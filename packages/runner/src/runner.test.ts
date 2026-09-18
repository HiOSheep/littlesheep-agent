// @littlesheep/runner — runner.test.ts
// E2E test: real SessionManager + MemoryStore + mock LlmClient.
// Validates createRunner run wiring + inbound persistence order.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from './runner.js';
import type { LlmClient, ChatRequest, ChatResponse, StreamChunk } from '@littlesheep/llm';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING, dataSubdirs } from '@littlesheep/branding';
import { textMessage, type AgentTool, type Message, type SessionId } from '@littlesheep/types';
import {
  attachmentManifestResourceId,
  attachmentResourceId,
  createMemoryV3ExperimentMarker,
} from '@littlesheep/memory-tree';
import { compareHarnessPaths, reduceDurableRunProjection } from '@littlesheep/harness';
import { SessionManager, maybeCompact } from '@littlesheep/session';

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

function assistantTexts(messages: Message[]): string[] {
  return messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n'))
    .filter(Boolean);
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

  it('resolves durable Harness mode per session without changing the global default', async () => {
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('unused')),
      bootstrapDir: dataDir,
      skillsDirs: [],
      durableHarnessMode: 'shadow',
      durableHarnessSessionOverrides: { 'session-next': 'next' },
    });
    createdRunners.push(runner);

    expect(runner.durableHarnessMode).toBe('shadow');
    expect(runner.durableHarnessModeForSession?.('session-next')).toBe('next');
    expect(runner.durableHarnessModeForSession?.('session-other')).toBe('shadow');
  });

  it('resolves durable Harness mode per origin with session precedence', async () => {
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('unused')),
      bootstrapDir: dataDir,
      skillsDirs: [],
      durableHarnessMode: 'shadow',
      durableHarnessSessionOverrides: { 'session-forced-shadow': 'shadow' },
      durableHarnessOriginOverrides: { app: 'next' },
    });
    createdRunners.push(runner);

    expect(runner.durableHarnessModeForSession?.('session-other', 'app')).toBe('next');
    expect(runner.durableHarnessModeForSession?.('session-other', 'cli')).toBe('shadow');
    expect(runner.durableHarnessModeForSession?.('session-other')).toBe('shadow');
    expect(runner.durableHarnessModeForSession?.('session-forced-shadow', 'app')).toBe('shadow');
  });

  it('applies origin overrides to real runs without changing the global default', async () => {
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('origin override reply')),
      durableHarnessMode: 'shadow',
      durableHarnessOriginOverrides: { app: 'next' },
    });
    createdRunners.push(runner);

    const appResult = await runner.run({ text: 'app origin turn', origin: 'app' });
    expect(appResult).toMatchObject({
      status: 'ok',
      reply: 'origin override reply',
      durableHarnessMode: 'next',
    });
    expect(appResult.finalReplySettlement?.status).toBe('settled');
    expect((await runner.replay(appResult.runId))?.durableHarnessMode).toBe('next');
    expect(await runner.durableHarnessModeForRun?.(String(appResult.sessionId), appResult.runId)).toBe('next');

    const cliResult = await runner.run({ text: 'cli origin turn', origin: 'cli' });
    expect(cliResult).toMatchObject({
      status: 'ok',
      reply: 'origin override reply',
      durableHarnessMode: 'shadow',
    });
    expect(runner.durableHarnessMode).toBe('shadow');
  });

  it('resolves durable Harness mode per behavior profile below origin and session', async () => {
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('unused')),
      bootstrapDir: dataDir,
      skillsDirs: [],
      durableHarnessMode: 'shadow',
      durableHarnessOriginOverrides: { cli: 'next' },
      durableHarnessProfileOverrides: { coding: 'next', general: 'shadow' },
    });
    createdRunners.push(runner);

    // Profile override applies when neither session nor origin pins the mode.
    expect(runner.durableHarnessModeForSession?.('session-other', undefined, 'coding')).toBe('next');
    expect(runner.durableHarnessModeForSession?.('session-other', undefined, 'general')).toBe('shadow');
    // Origin override outranks the profile override.
    expect(runner.durableHarnessModeForSession?.('session-other', 'cli', 'general')).toBe('next');
    // Session override outranks both.
    expect(runner.durableHarnessModeForSession?.('session-other')).toBe('shadow');
  });

  it('applies a behavior-profile override to a real run', async () => {
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('profile override reply')),
      durableHarnessMode: 'shadow',
      durableHarnessProfileOverrides: { coding: 'next' },
    });
    createdRunners.push(runner);

    const coding = await runner.run({ text: 'coding profile turn', profile: 'coding' });
    expect(coding).toMatchObject({
      status: 'ok',
      reply: 'profile override reply',
      durableHarnessMode: 'next',
    });
    expect(coding.finalReplySettlement?.status).toBe('settled');
    expect((await runner.replay(coding.runId))?.durableHarnessMode).toBe('next');
    expect(await runner.durableHarnessModeForRun?.(String(coding.sessionId), coding.runId)).toBe('next');

    const general = await runner.run({ text: 'general profile turn', profile: 'general' });
    expect((await runner.replay(general.runId))?.durableHarnessMode).toBe('shadow');
    expect(await runner.durableHarnessModeForRun?.(String(general.sessionId), general.runId)).toBe('shadow');
    expect(general).toMatchObject({
      status: 'ok',
      reply: 'profile override reply',
      durableHarnessMode: 'shadow',
    });
    expect(runner.durableHarnessMode).toBe('shadow');
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
    expect(replyRequest.messages.map((message) => String(message.content)).join('\n')).toContain('Memory Tree Root Index');
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
    const ingressEvents = events.filter((event) => (
      event.type === 'run_accepted' || event.type === 'user_input_appended'
    ));
    const inboxCommands = await Promise.all(ingressEvents.map((event) => runner.infra.durableInboxStore.read(event.eventId)));
    expect(inboxCommands).toHaveLength(2);
    expect(inboxCommands.every((command, index) => (
      command?.status === 'completed'
      && command.source === ingressEvents[index]?.source
      && command.claimToken === undefined
      && command.resultEventIds?.[0] === ingressEvents[index]?.eventId
    ))).toBe(true);
    expect(await runner.infra.durableInboxStore.read(
      events.find((event) => event.type === 'route_decided')?.eventId ?? 'missing',
    )).toBeNull();
    expect(events.filter((event) => event.type === 'stage_transition_recorded').length).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === 'final_reply_settled')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('run_completed');
    expect(await runner.infra.durableRunLeaseStore.read(String(result.sessionId), result.runId)).toMatchObject({
      status: 'released',
      attempts: 1,
    });
    const projection = reduceDurableRunProjection(events);
    expect(projection.status).toBe('completed');
    expect(projection.finalReply.state).toBe('settled');
    expect(projection.stageTransitions.map((transition) => transition.stage)).toEqual(
      result.trace.map((transition) => transition.name),
    );
  });

  it('holds a renewable durable run lease until a next run settles', async () => {
    let releaseFirstRequest!: () => void;
    const firstRequest = new Promise<void>((resolveRequest) => { releaseFirstRequest = resolveRequest; });
    const llm = makeMockLlm(textResponse('Lease-protected reply'));
    (llm.chat as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await firstRequest;
      return textResponse('{"type":"simple","confidence":0.99,"reason":"reply"}');
    });
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      durableHarnessMode: 'next',
    });
    createdRunners.push(runner);
    const session = await runner.sessionManager.create('test/model');
    const runId = 'lease-protected-run';

    const running = runner.run({ sessionId: session.id, runId, text: 'hello' });
    await expect.poll(() => (llm.chat as ReturnType<typeof vi.fn>).mock.calls.length, {
      timeout: 10_000,
    }).toBeGreaterThan(0);
    await expect(runner.infra.durableRunLeaseStore.listActiveRuns()).resolves.toEqual([{
      sessionId: String(session.id),
      runId,
    }]);
    await expect(runner.recoverDurableRun?.(session.id, runId))
      .rejects.toThrow('durable run is still owned');

    releaseFirstRequest();
    const result = await running;
    expect(result.status).toBe('ok');
    await expect(runner.infra.durableRunLeaseStore.read(String(session.id), runId)).resolves.toMatchObject({
      status: 'released',
      attempts: 1,
    });
  });

  it('holds an effect lease across real tool execution and releases it after settlement', async () => {
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolveTool) => { releaseTool = resolveTool; });
    let toolStarted = false;
    const tool: AgentTool = {
      name: 'held_write',
      description: 'Hold one mutation open for ownership inspection.',
      inputSchema: { parse: (input) => input, jsonSchema: { type: 'object' } },
      execution: {
        concurrency: 'exclusive',
        resources: () => [{ key: 'workspace:held-write', mode: 'write' }],
      },
      async execute() {
        toolStarted = true;
        await toolGate;
        return { callId: '', ok: true, output: 'held write complete' };
      },
    };
    const llm = makeMockLlm([
      {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{
          id: 'held-write-call',
          type: 'function',
          function: { name: 'held_write', arguments: '{"value":"secret"}' },
        }],
      },
      textResponse('Held write completed.'),
      textResponse('{"verdict":"pass","reason":"write completed"}'),
      textResponse('{"memories":[],"createSkill":null}'),
      textResponse('{"observations":[]}'),
    ]);
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      durableHarnessMode: 'next',
    });
    createdRunners.push(runner);
    const session = await runner.sessionManager.create('test/model');
    const runId = 'effect-lease-protected-run';
    const running = runner.run({ sessionId: session.id, runId, text: 'perform held write', additionalTools: [tool] });

    await expect.poll(() => toolStarted, { timeout: 10_000 }).toBe(true);
    const activeEvents = await runner.infra.durableEventStore.read(String(session.id), runId);
    const intent = activeEvents.find((event) => event.type === 'effect_intent_created');
    expect(intent?.payload).toMatchObject({
      ownerId: expect.stringMatching(/^[a-f0-9]{64}$/),
      leaseUntil: expect.any(String),
    });
    const effectId = String(intent?.payload.effectId);
    await expect(runner.infra.durableEffectLeaseStore.read({
      sessionId: String(session.id), runId, effectId,
    })).resolves.toMatchObject({ status: 'active', ownerToken: expect.any(String) });

    releaseTool();
    const result = await running;
    expect(result.status).toBe('ok');
    await expect(runner.infra.durableEffectLeaseStore.read({
      sessionId: String(session.id), runId, effectId,
    })).resolves.toMatchObject({ status: 'released', attempts: 1 });
  });

  it('compares shadow and next deterministically without duplicate replies or cache prefix drift', async () => {
    const shadowRunner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('comparison reply')),
      durableHarnessMode: 'shadow',
    });
    const nextRunner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('comparison reply')),
      durableHarnessMode: 'next',
    });
    createdRunners.push(shadowRunner, nextRunner);

    const shadow = await shadowRunner.run({ text: 'same comparison turn' });
    const next = await nextRunner.run({ text: 'same comparison turn' });
    const shadowEvents = await shadowRunner.infra.durableEventStore.read(
      String(shadow.sessionId),
      shadow.runId,
    );
    const nextEvents = await nextRunner.infra.durableEventStore.read(
      String(next.sessionId),
      next.runId,
    );
    expect(shadow).toMatchObject({ status: 'ok', reply: 'comparison reply', durableHarnessMode: 'shadow' });
    expect(next).toMatchObject({ status: 'ok', reply: 'comparison reply', durableHarnessMode: 'next' });
    expect(assistantTexts(await shadowRunner.sessionManager.read(shadow.sessionId))).toEqual(['comparison reply']);
    expect(assistantTexts(await nextRunner.sessionManager.read(next.sessionId))).toEqual(['comparison reply']);
    expect(shadowEvents.filter((event) => event.type === 'final_reply_settled')).toHaveLength(1);
    expect(nextEvents.filter((event) => event.type === 'final_reply_settled')).toHaveLength(1);
    expect(shadowEvents.filter((event) => event.type === 'run_completed')).toHaveLength(1);
    expect(nextEvents.filter((event) => event.type === 'run_completed')).toHaveLength(1);
    expect(shadowEvents.filter((event) => event.type === 'stage_transition_recorded')).toHaveLength(0);
    expect(nextEvents.filter((event) => event.type === 'stage_transition_recorded').length).toBeGreaterThan(0);
    expect(reduceDurableRunProjection(shadowEvents)).toMatchObject({
      status: 'completed',
      finalReply: { state: 'settled' },
    });
    expect(reduceDurableRunProjection(nextEvents)).toMatchObject({
      status: 'completed',
      finalReply: { state: 'settled' },
    });
    const shadowRequestKinds = shadow.modelRequests?.map((request) => request.cacheObservation?.requestKind);
    const nextRequestKinds = next.modelRequests?.map((request) => request.cacheObservation?.requestKind);
    expect(shadowRequestKinds).toEqual(nextRequestKinds);
    expect(shadow.modelRequests?.length).toBe(next.modelRequests?.length);
    // The two harness paths intentionally assemble different stable prompts, so
    // Provider cache cannot be shared across a cutover and must be measured per path.
    expect(shadow.modelRequests?.map((request) => request.cacheObservation?.stablePrefix.fingerprint))
      .not.toEqual(next.modelRequests?.map((request) => request.cacheObservation?.stablePrefix.fingerprint));
    const promptEstimate = (result: Awaited<ReturnType<typeof shadowRunner.run>>) => (
      result.contextSnapshots?.reduce(
        (total, snapshot) => total + (snapshot.safetyEstimate?.estimatedPromptTokens ?? 0),
        0,
      ) ?? 0
    );
    const shadowPromptEstimate = promptEstimate(shadow);
    const nextPromptEstimate = promptEstimate(next);
    expect(shadowPromptEstimate).toBeGreaterThan(0);
    expect(nextPromptEstimate).toBeGreaterThan(0);
    expect(nextPromptEstimate).toBeLessThanOrEqual(shadowPromptEstimate * 1.5);
  });

  it('compares shadow and next tool execution without duplicate side effects', async () => {
    const responses = () => [
      {
        content: '',
        finishReason: 'tool_calls' as const,
        toolCalls: [{
          id: 'comparison-write-call',
          type: 'function' as const,
          function: { name: 'checkpoint_write', arguments: '{}' },
        }],
      },
      textResponse('Checkpoint write completed.'),
      textResponse('{"verdict":"pass","reason":"checkpoint proof exists"}'),
      textResponse('{"memories":[],"createSkill":null}'),
      textResponse('{"observations":[]}'),
    ];
    const runMode = async (mode: 'shadow' | 'next') => {
      const calls: string[] = [];
      const tool: AgentTool = {
        name: 'checkpoint_write',
        description: 'Create a checkpointed comparison mutation.',
        inputSchema: { parse: (input) => input, jsonSchema: { type: 'object' } },
        execution: {
          concurrency: 'exclusive',
          resources: () => [{ key: 'workspace:comparison-proof', mode: 'write' }],
        },
        async execute() {
          calls.push('checkpoint_write');
          return { callId: '', ok: true, output: 'comparison-proof' };
        },
      };
      const runner = await createRunner({
        config: DEFAULT_CONFIG,
        branding: DEFAULT_BRANDING,
        model: 'test/model',
        llm: makeMockLlm(responses()),
        durableHarnessMode: mode,
      });
      createdRunners.push(runner);
      const result = await runner.run({
        text: 'write comparison proof',
        additionalTools: [tool],
      });
      const events = await runner.infra.durableEventStore.read(String(result.sessionId), result.runId);
      return { result, events, calls };
    };

    const shadow = await runMode('shadow');
    const next = await runMode('next');

    expect(shadow.calls).toEqual(['checkpoint_write']);
    expect(next.calls).toEqual(['checkpoint_write']);
    expect(shadow.result).toMatchObject({ status: 'ok', reply: next.result.reply });
    expect(next.result).toMatchObject({ status: 'ok' });
    expect(shadow.result.sideEffects?.filter((effect) => effect.toolName === 'checkpoint_write'))
      .toHaveLength(1);
    expect(next.result.sideEffects?.filter((effect) => effect.toolName === 'checkpoint_write'))
      .toHaveLength(1);
    expect(shadow.result.sideEffects?.[0]).toMatchObject({ status: 'succeeded' });
    expect(next.result.sideEffects?.[0]).toMatchObject({ status: 'succeeded' });
    expect(shadow.events.filter((event) => event.type === 'stage_transition_recorded')).toHaveLength(0);
    expect(next.events.filter((event) => event.type === 'stage_transition_recorded').length).toBeGreaterThan(0);
    expect(shadow.result.modelRequests?.length).toBe(next.result.modelRequests?.length);
    expect(shadow.result.modelRequests?.map((request) => request.cacheObservation?.requestKind))
      .toEqual(next.result.modelRequests?.map((request) => request.cacheObservation?.requestKind));
    expect(shadow.result.modelRequests?.map((request) => request.cacheObservation?.stablePrefix.fingerprint))
      .not.toEqual(next.result.modelRequests?.map((request) => request.cacheObservation?.stablePrefix.fingerprint));
  });

  it('next path fails closed when execution-log persistence fails before settlement', async () => {
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('must not publish')),
      durableHarnessMode: 'next',
    });
    createdRunners.push(runner);
    vi.spyOn(runner.infra.executionLogStore, 'write').mockRejectedValue(new Error('audit disk full'));

    const result = await runner.run({ text: 'execution log outage' });

    expect(result.status).toBe('error');
    expect(result.reply).toBe('');
    expect(result.finalReplySettlement).toBeUndefined();
    expect(result.runtimeStatus).toMatchObject({ status: 'failed', reason: 'finalize_persistence_failed' });
    expect(result.messages.some((message) => message.role === 'assistant' && message.stage === 'finalize')).toBe(false);

    const events = await runner.infra.durableEventStore.read(String(result.sessionId), result.runId);
    expect(events.filter((event) => event.type === 'final_reply_settled')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'run_completed')).toHaveLength(0);
    expect(events.at(-1)?.type).toBe('runtime_status_settled');
    const projection = reduceDurableRunProjection(events);
    expect(projection.finalReply.state).toBe('runtime_status');
    await expect(runner.replayDurableFinalReply!(result.sessionId, result.runId)).resolves.toMatchObject({
      kind: 'runtime_status',
      status: 'failed',
      reason: 'finalize_persistence_failed',
    });
  });

  it('next path fails closed when the session summary cannot be persisted', async () => {
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('must not publish summary outage')),
      durableHarnessMode: 'next',
    });
    createdRunners.push(runner);
    vi.spyOn(runner.infra.executionLogStore, 'writeLatestForSession')
      .mockRejectedValue(new Error('summary disk full'));

    const result = await runner.run({ text: 'summary persistence outage' });

    expect(result.status).toBe('error');
    expect(result.reply).toBe('');
    expect(result.runtimeStatus).toMatchObject({ status: 'failed', reason: 'finalize_persistence_failed' });
    const events = await runner.infra.durableEventStore.read(String(result.sessionId), result.runId);
    expect(events.filter((event) => event.type === 'final_reply_settled')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'run_completed')).toHaveLength(0);
    expect(reduceDurableRunProjection(events).finalReply.state).toBe('runtime_status');
  });

  it('next path fails closed when the final assistant transcript cannot be persisted', async () => {
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('must not publish transcript outage')),
      durableHarnessMode: 'next',
    });
    createdRunners.push(runner);
    const append = runner.infra.sessionManager.append.bind(runner.infra.sessionManager);
    let blockedAttempts = 0;
    vi.spyOn(runner.infra.sessionManager, 'append').mockImplementation(async (sessionId, messages) => {
      if (messages.some((message) => message.role === 'assistant' && message.stage === 'finalize')) {
        blockedAttempts += 1;
        throw new Error('session transcript disk full');
      }
      return append(sessionId, messages);
    });

    const result = await runner.run({ text: 'transcript persistence outage' });

    expect(blockedAttempts).toBeGreaterThan(0);
    expect(result.status).toBe('error');
    expect(result.reply).toBe('');
    expect(result.runtimeStatus).toMatchObject({ status: 'failed', reason: 'session_persist_failed' });
    const events = await runner.infra.durableEventStore.read(String(result.sessionId), result.runId);
    expect(events.filter((event) => event.type === 'final_reply_settled')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'run_completed')).toHaveLength(0);
    expect(reduceDurableRunProjection(events).finalReply.state).toBe('runtime_status');
    expect((await runner.sessionManager.read(result.sessionId))
      .some((message) => message.role === 'assistant' && message.stage === 'finalize'))
      .toBe(false);
  });

  it('next path fails closed when the final-reply registry settlement fails', async () => {
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('must not publish registry outage')),
      durableHarnessMode: 'next',
    });
    createdRunners.push(runner);
    vi.spyOn(runner.infra.sessionManager, 'settleAssistantReplySettlement')
      .mockRejectedValue(new Error('reply registry unavailable'));

    const result = await runner.run({ text: 'reply registry outage' });

    expect(result.status).toBe('error');
    expect(result.reply).toBe('');
    expect(result.runtimeStatus).toMatchObject({ status: 'failed', reason: 'final_reply_settlement_failed' });
    const events = await runner.infra.durableEventStore.read(String(result.sessionId), result.runId);
    expect(events.filter((event) => event.type === 'final_reply_settled')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'run_completed')).toHaveLength(0);
    expect(reduceDurableRunProjection(events).finalReply.state).toBe('settled');
  });

  it('next path fails closed when the final-reply durable event cannot be appended', async () => {
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('must not publish event outage')),
      durableHarnessMode: 'next',
    });
    createdRunners.push(runner);
    const append = runner.infra.durableEventStore.append.bind(runner.infra.durableEventStore);
    vi.spyOn(runner.infra.durableEventStore, 'append').mockImplementation(async (input) => {
      if (input.type === 'final_reply_settled') throw new Error('durable event disk full');
      return append(input);
    });

    const result = await runner.run({ text: 'durable event outage' });

    expect(result.status).toBe('error');
    expect(result.reply).toBe('');
    expect(result.runtimeStatus).toMatchObject({ status: 'failed', reason: 'final_reply_settlement_failed' });
    const events = await runner.infra.durableEventStore.read(String(result.sessionId), result.runId);
    expect(events.filter((event) => event.type === 'final_reply_settled')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'run_completed')).toHaveLength(0);
    expect(reduceDurableRunProjection(events).finalReply.state).toBe('proposed');
  });

  it('retries a failed next run by returning bounded Runtime status across runner restart', async () => {
    const firstRunner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('must remain a proposal')),
      durableHarnessMode: 'next',
    });
    createdRunners.push(firstRunner);
    const session = await firstRunner.sessionManager.create('test/model');
    vi.spyOn(firstRunner.infra.executionLogStore, 'write')
      .mockRejectedValue(new Error('audit disk full'));

    const first = await firstRunner.run({
      sessionId: session.id,
      requestKey: 'retry-after-persistence-failure',
      text: 'same durable turn',
    });
    expect(first.status).toBe('error');
    expect(first.reply).toBe('');
    expect(first.runtimeStatus).toMatchObject({ status: 'failed' });
    expect((await firstRunner.sessionManager.read(session.id)).filter((message) => message.role === 'assistant'))
      .toHaveLength(1);
    await firstRunner.shutdown();
    createdRunners.pop();

    const llm = makeMockLlm(textResponse('must not be called on retry'));
    const restarted = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      durableHarnessMode: 'next',
    });
    createdRunners.push(restarted);

    const second = await restarted.run({
      sessionId: session.id,
      requestKey: 'retry-after-persistence-failure',
      text: 'same durable turn',
    });
    expect(second.status).toBe('error');
    expect(second.reply).toBe('');
    expect(second.runtimeStatus).toMatchObject({ status: 'failed', reason: 'finalize_persistence_failed' });
    expect(llm.chat).not.toHaveBeenCalled();
    expect((await restarted.sessionManager.read(session.id)).filter((message) => message.role === 'assistant'))
      .toHaveLength(1);
    expect(second.messages.some((message) => message.role === 'assistant' && message.stage === 'finalize'))
      .toBe(false);
  });

  it('switches next to shadow and back without duplicating replies or settlements', async () => {
    const firstRunner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('next reply one')),
      durableHarnessMode: 'next',
    });
    createdRunners.push(firstRunner);
    const first = await firstRunner.run({ text: 'first turn' });
    expect(first).toMatchObject({
      status: 'ok',
      reply: 'next reply one',
      durableHarnessMode: 'next',
    });
    const sessionId = first.sessionId;
    await firstRunner.shutdown();
    createdRunners.pop();

    const shadowRunner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('shadow reply two')),
      durableHarnessMode: 'shadow',
    });
    createdRunners.push(shadowRunner);
    const second = await shadowRunner.run({ sessionId, text: 'second turn' });
    expect(second).toMatchObject({
      status: 'ok',
      reply: 'shadow reply two',
      durableHarnessMode: 'shadow',
    });
    expect(assistantTexts(await shadowRunner.sessionManager.read(sessionId)))
      .toEqual(['next reply one', 'shadow reply two']);
    const firstRunEvents = await shadowRunner.infra.durableEventStore.read(String(sessionId), first.runId);
    expect(firstRunEvents.filter((event) => event.type === 'final_reply_settled')).toHaveLength(1);
    expect(firstRunEvents.filter((event) => event.type === 'run_completed')).toHaveLength(1);
    await shadowRunner.shutdown();
    createdRunners.pop();

    const nextAgainRunner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('next reply three')),
      durableHarnessMode: 'next',
    });
    createdRunners.push(nextAgainRunner);
    const third = await nextAgainRunner.run({ sessionId, text: 'third turn' });
    expect(third).toMatchObject({
      status: 'ok',
      reply: 'next reply three',
      durableHarnessMode: 'next',
    });
    expect(third.finalReplySettlement?.status).toBe('settled');
    expect(assistantTexts(await nextAgainRunner.sessionManager.read(sessionId)))
      .toEqual(['next reply one', 'shadow reply two', 'next reply three']);
  });

  it('explains a cross-run model change from the persisted cache observation', async () => {
    const firstRunner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'openai/model-a',
      llm: makeMockLlm(textResponse('first model reply')),
    });
    createdRunners.push(firstRunner);
    const first = await firstRunner.run({ text: 'first model turn' });
    expect(first).toMatchObject({ status: 'ok', reply: 'first model reply' });
    await firstRunner.shutdown();
    createdRunners.pop();

    const secondRunner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'openai/model-b',
      llm: makeMockLlm(textResponse('second model reply')),
    });
    createdRunners.push(secondRunner);
    const second = await secondRunner.run({ sessionId: first.sessionId, text: 'second model turn' });
    expect(second).toMatchObject({ status: 'ok', reply: 'second model reply' });

    const observation = second.modelRequests?.[0]?.cacheObservation;
    expect(observation?.invalidationReasons).toContain('model_changed');
  });

  it('explains a configuration hot reload from the persisted cache observation', async () => {
    const firstRunner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('first config reply')),
    });
    createdRunners.push(firstRunner);
    const first = await firstRunner.run({ text: 'first config turn' });
    expect(first).toMatchObject({ status: 'ok', reply: 'first config reply' });
    await firstRunner.shutdown();
    createdRunners.pop();

    const changedConfig = structuredClone(DEFAULT_CONFIG);
    changedConfig.agents.defaults.profile = 'coding';
    const secondRunner = await createRunner({
      config: changedConfig,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('second config reply')),
    });
    createdRunners.push(secondRunner);
    const second = await secondRunner.run({ sessionId: first.sessionId, text: 'second config turn' });
    expect(second).toMatchObject({ status: 'ok', reply: 'second config reply' });

    const observation = second.modelRequests?.find((request) => request.cacheObservation)?.cacheObservation;
    expect(observation?.invalidationReasons).toContain('system_policy_changed');
  });

  it('explains a harness path switch from the persisted cache observation', async () => {
    const shadowRunner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('shadow path reply')),
      durableHarnessMode: 'shadow',
    });
    createdRunners.push(shadowRunner);
    const first = await shadowRunner.run({ text: 'path switch turn' });
    expect(first).toMatchObject({ status: 'ok', durableHarnessMode: 'shadow' });
    await shadowRunner.shutdown();
    createdRunners.pop();

    const nextRunner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('next path reply')),
      durableHarnessMode: 'next',
    });
    createdRunners.push(nextRunner);
    const second = await nextRunner.run({ sessionId: first.sessionId, text: 'path switch turn two' });
    expect(second).toMatchObject({ status: 'ok', durableHarnessMode: 'next' });

    const observation = second.modelRequests?.find((request) => request.cacheObservation)?.cacheObservation;
    // Switching the harness path changes the assembled prompt and the request
    // sequence, so the ledger must explain the miss explicitly instead of
    // silently reporting a hit or falling back to `unknown`.
    expect(observation?.invalidationReasons).toContain('prompt_version_changed');
    expect(observation?.invalidationReasons?.length ?? 0).toBeGreaterThan(0);
    expect(observation?.invalidationReasons).not.toContain('unknown');
    // No authoritative cache usage was produced in this fixture, so the ledger
    // stays `unavailable` with no computed hit ratio rather than inventing one.
    expect(observation?.providerPrompt.status).toBe('unavailable');
    expect(observation?.providerPrompt.hitRatio).toBeUndefined();
  });

  it('tells the user why a next run failed instead of only the settlement code', async () => {
    const llm = makeMockLlm(() => {
      throw new Error('Authentication Fails, Your api key: ****dead is invalid');
    });
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      durableHarnessMode: 'next',
    });
    createdRunners.push(runner);

    const result = await runner.run({ text: '你好' });
    expect(result.status).toBe('error')
    expect(result.reply).toBe('')
    expect(result.finalReplySettlement).toBeUndefined()
    expect(result.runtimeStatus).toMatchObject({ status: 'failed' })
    // The actionable Provider cause must survive the fail-closed boundary.
    expect(result.error).toContain('Authentication Fails')
    expect(result.messages.every((message) => message.role !== 'assistant' || message.stage !== 'finalize')).toBe(true)

    // History reload must show the same cause, not a different code.
    const replay = await runner.replay(result.runId)
    expect(replay?.error).toContain('Authentication Fails')
  })

  it('replays a completed request through the per-session durable mode', async () => {
    const firstRunner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('settled replay reply')),
      durableHarnessMode: 'next',
    });
    createdRunners.push(firstRunner);
    const session = await firstRunner.sessionManager.create('test/model');
    const requestKey = 'per-session-replay-key';
    const first = await firstRunner.run({ sessionId: session.id, text: 'replay me', requestKey });
    expect(first.status).toBe('ok');
    await firstRunner.shutdown();
    createdRunners.pop();

    const replayLlm = makeMockLlm(textResponse('must not execute'));
    const secondRunner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: replayLlm,
      durableHarnessMode: 'shadow',
      durableHarnessSessionOverrides: { [String(session.id)]: 'next' },
    });
    createdRunners.push(secondRunner);
    const replayed = await secondRunner.run({ sessionId: session.id, text: 'replay me', requestKey });

    expect(replayed).toMatchObject({ status: 'ok', reply: 'settled replay reply' });
    expect(replayed.finalReplySettlement?.status).toBe('settled');
    expect(replayLlm.chat).not.toHaveBeenCalled();
  });

  it('keeps concurrent session cache observations isolated with versioning enabled', async () => {
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('concurrent reply')),
    });
    createdRunners.push(runner);
    expect(runner.infra.versioning).toBeDefined();
    const sessionA = await runner.sessionManager.create('test/model');
    const sessionB = await runner.sessionManager.create('test/model');
    const [first, second] = await Promise.all([
      runner.run({ sessionId: sessionA.id, text: 'session a turn' }),
      runner.run({ sessionId: sessionB.id, text: 'session b turn' }),
    ]);
    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');

    const scope = (sessionId: SessionId) => ({
      sessionId: String(sessionId),
      workspaceScope: process.cwd(),
      permissionPolicyId: 'research' as const,
      key: runner.infra.cacheObservationKey ?? '',
    });
    const observationA = await runner.infra.cacheObservationStore?.latest(scope(sessionA.id));
    const observationB = await runner.infra.cacheObservationStore?.latest(scope(sessionB.id));

    expect(observationA?.scope.partitionDigest).toEqual(expect.any(String));
    expect(observationB?.scope.partitionDigest).toEqual(expect.any(String));
    expect(observationA?.scope.partitionDigest).not.toBe(observationB?.scope.partitionDigest);
    expect(JSON.stringify(observationA)).not.toContain(String(sessionB.id));
    expect(JSON.stringify(observationB)).not.toContain(String(sessionA.id));
  });

  it('keeps a settled success when run_completed append fails and repairs it without replaying effects', async () => {
    const llm = makeMockLlm(textResponse('settled before completion receipt'));
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      durableHarnessMode: 'next',
    });
    createdRunners.push(runner);
    const append = runner.infra.durableEventStore.append.bind(runner.infra.durableEventStore);
    let completionAttempts = 0;
    vi.spyOn(runner.infra.durableEventStore, 'append').mockImplementation(async (input) => {
      if (input.type === 'run_completed' && completionAttempts++ === 0) {
        throw new Error('completion receipt disk full');
      }
      return append(input);
    });

    const result = await runner.run({ text: 'completion receipt outage' });
    expect(result.status).toBe('ok');
    expect(result.reply).toBe('settled before completion receipt');
    expect(result.finalReplySettlement?.status).toBe('settled');
    const modelCallsBeforeRecovery = (llm.chat as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(modelCallsBeforeRecovery).toBeGreaterThan(0);
    expect(llm.chat).toHaveBeenCalledTimes(modelCallsBeforeRecovery);
    expect((await runner.sessionManager.read(result.sessionId)).filter((message) => message.role === 'assistant'))
      .toHaveLength(1);

    const beforeRecovery = await runner.infra.durableEventStore.read(String(result.sessionId), result.runId);
    expect(beforeRecovery.filter((event) => event.type === 'final_reply_settled')).toHaveLength(1);
    expect(beforeRecovery.filter((event) => event.type === 'run_completed')).toHaveLength(0);

    const recovery = await runner.recoverDurableRun!(result.sessionId, result.runId);
    expect(recovery.actions.map((action) => action.kind)).toContain('run_completed');
    expect(recovery.projection.status).toBe('completed');
    expect(recovery.projection.finalReply.state).toBe('settled');
    expect(llm.chat).toHaveBeenCalledTimes(modelCallsBeforeRecovery);
    expect((await runner.sessionManager.read(result.sessionId)).filter((message) => message.role === 'assistant'))
      .toHaveLength(1);
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
        request.messages.some((message) => String(message.content).includes('Regeneration contract'))
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
    const durable = reduceDurableRunProjection(
      await restarted.infra.durableEventStore.read(String(second.sessionId), second.runId),
    );
    const rewriteRequest = durable.modelRequests.find((request) => request.retryOf);
    expect(rewriteRequest?.retryOf).toBe(durable.modelRequests[0]?.requestId);
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
      durableHarnessMode: 'next',
    });
    createdRunners.push(runner);

    const result = await runner.run({ text: 'hello' });

    expect(result.usage).toEqual({
      promptTokens: 240,
      completionTokens: 12,
      totalTokens: 252,
      requestCount: 1,
      usageReportedRequestCount: 1,
      timedRequestCount: 0,
      timedCompletionTokens: 0,
      cacheReportedRequestCount: 0,
      usageCompleteness: 'complete',
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

  it('persists production cache observations across restart without crossing scope boundaries', async () => {
    const workspace = join(dataDir, 'cache-workspace');
    mkdirSync(workspace, { recursive: true });
    const secret = 'runner-cache-user-secret';
    const llm = makeMockLlm({
      ...textResponse('redacted cache reply'),
      usage: {
        promptTokens: 240,
        completionTokens: 12,
        totalTokens: 252,
        cachedPromptTokens: 120,
      },
    });
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
    });
    createdRunners.push(runner);

    const result = await runner.run({ text: secret, cwd: workspace });
    expect(result.status).toBe('ok');
    const request = result.modelRequests?.find((candidate) => candidate.cacheObservation);
    const observation = request?.cacheObservation;
    expect(observation).toBeDefined();
    expect(observation?.providerPrompt).toMatchObject({
      status: 'partial',
      tokenCount: 240,
      cachedTokenCount: 120,
    });
    expect(typeof runner.infra.cacheObservationKey).toBe('string');
    const entryFingerprint = observation?.normalizedRequest.fingerprint;
    expect(entryFingerprint).toMatch(/^[a-f0-9]{64}$/u);

    const observationRoot = join(dataDir, 'cache-observations');
    const persistedFiles = readdirSync(observationRoot).filter((file) => file.endsWith('.json'));
    expect(persistedFiles.length).toBeGreaterThan(0);
    const persisted = persistedFiles.map((file) => readFileSync(join(observationRoot, file), 'utf8')).join('\n');
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain('Stable policy');
    expect(persisted).not.toContain('provider-raw-payload');
    expect(persisted).not.toContain('tool-argument-secret');

    const lookupInput = {
      sessionId: String(result.sessionId),
      workspaceScope: workspace,
      permissionPolicyId: result.resolvedRunConfig?.permissionPolicyId,
      key: runner.infra.cacheObservationKey,
      entryFingerprint: entryFingerprint!,
    };
    await expect(runner.infra.cacheObservationStore?.lookup(lookupInput)).resolves.toMatchObject({
      status: 'hit',
      observation: {
        modelRequestId: observation?.modelRequestId,
        providerPrompt: { status: 'partial', cachedTokenCount: 120 },
      },
    });

    await runner.shutdown();
    createdRunners.pop();
    const restarted = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('unused after restart')),
    });
    createdRunners.push(restarted);

    await expect(restarted.infra.cacheObservationStore?.lookup({
      ...lookupInput,
      key: restarted.infra.cacheObservationKey,
    })).resolves.toMatchObject({ status: 'hit' });
    await expect(restarted.infra.cacheObservationStore?.lookup({
      ...lookupInput,
      sessionId: 'different-session',
      key: restarted.infra.cacheObservationKey,
    })).resolves.toMatchObject({ status: 'miss', reason: 'not_found' });
    await expect(restarted.infra.cacheObservationStore?.lookup({
      ...lookupInput,
      workspaceScope: join(dataDir, 'different-workspace'),
      key: restarted.infra.cacheObservationKey,
    })).resolves.toMatchObject({ status: 'miss', reason: 'not_found' });
    await expect(restarted.infra.cacheObservationStore?.lookup({
      ...lookupInput,
      permissionPolicyId: 'restricted',
      key: restarted.infra.cacheObservationKey,
    })).resolves.toMatchObject({ status: 'miss', reason: 'not_found' });
  });

  it('loads bounded session model requests for cache quality reports', async () => {
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('cache quality request reply')),
      durableHarnessMode: 'next',
    });
    createdRunners.push(runner);

    const result = await runner.run({ text: 'cache quality request' });
    expect(result.status).toBe('ok');
    const sessionProjection = await runner.infra.loadSessionDurableProjection?.(String(result.sessionId));
    const requests = sessionProjection?.modelRequests;
    expect(requests?.length).toBeGreaterThan(0);
    const durable = reduceDurableRunProjection(
      await runner.infra.durableEventStore.read(String(result.sessionId), result.runId),
    );
    expect(requests?.map((request) => request.requestId))
      .toEqual(durable.modelRequests.map((request) => request.requestId));
  });

  it('builds an end-to-end cache quality report from real runner observations', async () => {
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm([
        {
          ...textResponse('first cache reply'),
          usage: { promptTokens: 100, completionTokens: 10, cachedPromptTokens: 0 },
        },
        {
          ...textResponse('second cache reply'),
          usage: { promptTokens: 100, completionTokens: 10, cachedPromptTokens: 60 },
        },
      ]),
      durableHarnessMode: 'next',
    });
    createdRunners.push(runner);

    const first = await runner.run({ text: 'hello cache' });
    const second = await runner.run({ sessionId: first.sessionId, text: 'hello cache again' });
    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
    const sessionProjection = await runner.infra.loadSessionDurableProjection?.(String(first.sessionId));
    const key = runner.infra.cacheObservationKey;
    expect(key).toEqual(expect.any(String));
    const report = await runner.infra.cacheObservationStore?.report({
      sessionId: String(first.sessionId),
      workspaceScope: DEFAULT_CONFIG.agents.defaults.workspace,
      permissionPolicyId: second.resolvedRunConfig?.permissionPolicyId ?? 'research',
      key,
      modelRequests: sessionProjection?.modelRequests,
      verifications: sessionProjection?.verifications,
    });

    expect(report).toMatchObject({
      status: 'available',
      report: {
        requestCount: 2,
        providerTokens: {
          requestCount: 2,
          completeRequestCount: 2,
          unavailableRequestCount: 0,
          promptTokens: 200,
          completionTokens: 20,
          cachedPromptTokens: 60,
        },
        outcomes: {
          requestCount: 2,
          receivedCount: 2,
          receivedRate: 1,
          failureRate: 0,
        },
        verification: {
          verificationCount: 0,
        },
        releaseGate: {
          status: 'blocked',
        },
      },
    });
    if (report?.status !== 'available') throw new Error('cache quality report unexpectedly unavailable');
    expect(report.report.providerPrompt.hitRatio).toBeCloseTo(0.3);
    expect(report.report.releaseGate.reasons).toContain('real_provider_reconciliation_not_verified');
    expect(report.report.releaseGate.reasons).toContain('quality_continuity_not_observed');
  });

  it('reports a CACHE-09 path comparison from real shadow and next observations', async () => {
    const runMode = async (mode: 'shadow' | 'next') => {
      const runner = await createRunner({
        config: DEFAULT_CONFIG,
        branding: DEFAULT_BRANDING,
        model: 'test/model',
        llm: makeMockLlm({
          ...textResponse('path comparison reply'),
          usage: { promptTokens: 100, completionTokens: 10, cachedPromptTokens: 0 },
        }),
        durableHarnessMode: mode,
      });
      createdRunners.push(runner);
      const result = await runner.run({ text: 'path comparison input' });
      expect(result.status).toBe('ok');
      const projection = await runner.infra.loadSessionDurableProjection?.(String(result.sessionId));
      const key = runner.infra.cacheObservationKey;
      const report = await runner.infra.cacheObservationStore?.report({
        sessionId: String(result.sessionId),
        workspaceScope: DEFAULT_CONFIG.agents.defaults.workspace,
        permissionPolicyId: result.resolvedRunConfig?.permissionPolicyId ?? 'research',
        key,
        modelRequests: projection?.modelRequests,
        verifications: projection?.verifications,
      });
      if (report?.status !== 'available') throw new Error(`cache quality report unavailable for ${mode}`);
      return report.report;
    };

    const shadow = await runMode('shadow');
    const next = await runMode('next');
    const comparison = compareHarnessPaths([
      { label: 'shadow', report: shadow },
      { label: 'next', report: next },
    ]);
    expect(comparison.paths.map((entry) => entry.label)).toEqual(['shadow', 'next']);
    for (const path of comparison.paths) {
      expect(path.summary.requestCount).toBeGreaterThan(0);
      expect(path.summary.promptTokens).toBeGreaterThan(0);
      expect(path.summary.releaseGateStatus).toBe('blocked');
    }
    expect(comparison.deltas.promptTokens).toBe(0);
    expect(comparison.deltas.requestCount).toBe(0);
    expect(shadow.providerPrompt.hitRatio).toBe(0);
    expect(next.providerPrompt.hitRatio).toBe(0);
  });

  it('keeps a normal Runner reply successful when cache observation persistence fails', async () => {
    const logs: string[] = [];
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm({
        ...textResponse('reply despite cache store failure'),
        usage: { promptTokens: 80, completionTokens: 8, cachedPromptTokens: 40 },
      }),
      log: (_level, message) => { logs.push(message); },
    });
    createdRunners.push(runner);
    expect(runner.infra.cacheObservationStore).toBeDefined();
    vi.spyOn(runner.infra.cacheObservationStore!, 'put').mockRejectedValue(new Error('simulated cache store outage'));

    const result = await runner.run({ text: 'cache persistence must not block this reply' });
    expect(result.status).toBe('ok');
    expect(result.reply).toBe('reply despite cache store failure');
    expect(logs.some((message) => message.includes('cache observation persistence failed'))).toBe(true);
  });

  it('persists unavailable Provider usage rather than inventing a cache hit', async () => {
    const workspace = join(dataDir, 'missing-usage-workspace');
    mkdirSync(workspace, { recursive: true });
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('reply without usage')),
    });
    createdRunners.push(runner);

    const result = await runner.run({ text: 'provider omitted usage', cwd: workspace });
    expect(result.status).toBe('ok');
    const request = result.modelRequests?.find((candidate) => candidate.cacheObservation);
    expect(request?.cacheObservation?.providerPrompt).toMatchObject({
      status: 'unavailable',
      reason: 'provider_usage_missing',
    });
    const observation = request?.cacheObservation;
    expect(observation?.normalizedRequest.fingerprint).toBeTruthy();
    await expect(runner.infra.cacheObservationStore?.lookup({
      sessionId: String(result.sessionId),
      workspaceScope: workspace,
      permissionPolicyId: result.resolvedRunConfig?.permissionPolicyId,
      key: runner.infra.cacheObservationKey,
      entryFingerprint: observation!.normalizedRequest.fingerprint!,
    })).resolves.toMatchObject({
      status: 'hit',
      observation: { providerPrompt: { status: 'unavailable', reason: 'provider_usage_missing' } },
    });
  });

  it('settles next-harness requests when Provider usage is completely absent', async () => {
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('next reply without usage')),
      durableHarnessMode: 'next',
    });
    createdRunners.push(runner);

    const result = await runner.run({ text: 'provider omitted usage in next mode' });
    expect(result.status).toBe('ok');
    const projection = reduceDurableRunProjection(
      await runner.infra.durableEventStore.read(String(result.sessionId), result.runId),
    );
    expect(projection.modelRequests.length).toBeGreaterThan(0);
    expect(projection.modelRequests.every((request) => request.status === 'received')).toBe(true);
    expect(projection.modelRequests.every((request) => request.usageStatus === 'unavailable')).toBe(true);
    expect(projection.modelRequests[0]).toMatchObject({
      status: 'received',
      usageStatus: 'unavailable',
      providerReachStatus: 'reached',
      transportStatus: 'completed',
    });
    expect(projection.modelRequests.every((request) => request.providerUsage === undefined)).toBe(true);
    expect(projection.status).toBe('completed');
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
      toolResponse,
      textResponse('Both probes completed.'),
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
      toolResponse,
      textResponse('Checkpoint write completed.'),
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

  it('keeps an unknown end-to-end effect from being retried or published as success', async () => {
    const workspace = join(dataDir, 'unknown-effect-workspace');
    mkdirSync(workspace, { recursive: true });
    let toolCalls = 0;
    const mutateProbe: AgentTool = {
      name: 'mutate_probe',
      description: 'Perform one mutation whose outcome is unknown.',
      inputSchema: { parse: (input) => input, jsonSchema: { type: 'object' } },
      execution: {
        concurrency: 'exclusive',
        resources: () => [{ key: 'workspace:unknown-effect', mode: 'write' }],
      },
      async execute() {
        toolCalls += 1;
        writeFileSync(join(workspace, 'unknown-effect.txt'), 'partial mutation', 'utf8');
        throw new Error('mutation outcome unknown');
      },
    };
    let toolCallIssued = false;
    const llm = makeMockLlm((request) => {
      const serialized = JSON.stringify(request.messages);
      if (serialized.includes('Choose the next LittleSheep activity')) {
        return textResponse('{"type":"problem","confidence":0.99,"reason":"execute the mutating probe"}');
      }
      if (serialized.includes('You are the RECOVER stage')) {
        return textResponse('{"action":"abort","reason":"unknown side effect requires user decision"}');
      }
      if (serialized.includes('You are the VERIFY stage')) {
        return textResponse('{"verdict":"fail","reason":"the effect outcome is unknown"}');
      }
      if (serialized.includes('You are the DECIDE stage')) {
        return textResponse('{"plan":[{"description":"run the mutating probe","tools":["mutate_probe"]}]}');
      }
      if (!toolCallIssued && !request.messages.some((message) => message.role === 'tool')) {
        toolCallIssued = true;
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'unknown-effect-call',
            type: 'function',
            function: { name: 'mutate_probe', arguments: '{}' },
          }],
        };
      }
      if (request.messages.some((message) => message.role === 'tool')) {
        return textResponse('The mutation did not produce a verifiable result.');
      }
      return textResponse('{"type":"problem","confidence":0.99,"reason":"execute the mutating probe"}');
    });
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      durableHarnessMode: 'next',
    });
    createdRunners.push(runner);

    const result = await runner.run({
      text: 'run the mutating probe',
      cwd: workspace,
      additionalTools: [mutateProbe],
    });

    expect(toolCalls).toBe(1);
    expect(result.sideEffects?.find((effect) => effect.toolName === 'mutate_probe')).toMatchObject({
      status: 'unknown',
    });
    const projection = reduceDurableRunProjection(
      await runner.infra.durableEventStore.read(String(result.sessionId), result.runId),
    );
    expect(projection.unknownEffectIds.length).toBeGreaterThan(0);
    expect(result.reply ?? '').not.toContain('success');
  });

  it('recovers a real effect with a failed settlement after restart without replaying it', async () => {
    const workspace = join(dataDir, 'effect-settlement-recovery-workspace');
    mkdirSync(workspace, { recursive: true });
    let toolCalls = 0;
    const mutateProbe: AgentTool = {
      name: 'mutate_probe',
      description: 'Perform one durable mutation whose settlement may be lost.',
      inputSchema: { parse: (input) => input, jsonSchema: { type: 'object' } },
      execution: {
        concurrency: 'exclusive',
        resources: () => [{ key: 'workspace:settlement-recovery', mode: 'write' }],
      },
      async execute() {
        toolCalls += 1;
        writeFileSync(join(workspace, 'settlement-recovery.txt'), 'mutation completed', 'utf8');
        return { callId: '', ok: true, output: 'mutation completed' };
      },
    };
    let toolCallIssued = false;
    const llm = makeMockLlm((request) => {
      const serialized = JSON.stringify(request.messages);
      if (serialized.includes('Choose the next LittleSheep activity')) {
        return textResponse('{"type":"problem","confidence":0.99,"reason":"execute the mutating probe"}');
      }
      if (serialized.includes('You are the RECOVER stage')) {
        return textResponse('{"action":"abort","reason":"the effect settlement is missing"}');
      }
      if (serialized.includes('You are the VERIFY stage')) {
        return textResponse('{"verdict":"fail","reason":"the effect was not durably settled"}');
      }
      if (serialized.includes('You are the DECIDE stage')) {
        return textResponse('{"plan":[{"description":"run the mutating probe","tools":["mutate_probe"]}]}');
      }
      if (!toolCallIssued && !request.messages.some((message) => message.role === 'tool')) {
        toolCallIssued = true;
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'settlement-recovery-call',
            type: 'function',
            function: { name: 'mutate_probe', arguments: '{}' },
          }],
        };
      }
      if (request.messages.some((message) => message.role === 'tool')) {
        return textResponse('The mutation was not durably settled.');
      }
      return textResponse('{"type":"problem","confidence":0.99,"reason":"execute the mutating probe"}');
    });
    const firstRunner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      durableHarnessMode: 'next',
    });
    createdRunners.push(firstRunner);
    const append = firstRunner.infra.durableEventStore.append.bind(firstRunner.infra.durableEventStore);
    let settlementFailures = 0;
    vi.spyOn(firstRunner.infra.durableEventStore, 'append').mockImplementation(async (input) => {
      if (input.type === 'effect_settled' && settlementFailures++ === 0) {
        throw new Error('settlement receipt disk full');
      }
      return append(input);
    });

    const first = await firstRunner.run({
      runId: 'run-effect-settlement-recovery',
      text: 'run the mutating probe',
      cwd: workspace,
      additionalTools: [mutateProbe],
    });
    expect(toolCalls).toBe(1);
    expect(existsSync(join(workspace, 'settlement-recovery.txt'))).toBe(true);
    const beforeRestart = reduceDurableRunProjection(
      await firstRunner.infra.durableEventStore.read(String(first.sessionId), first.runId),
    );
    expect(beforeRestart.status).toBe('failed');
    expect(beforeRestart.pendingEffectIds.length).toBeGreaterThan(0);
    expect(beforeRestart.unknownEffectIds).toEqual([]);
    await firstRunner.shutdown();
    createdRunners.pop();

    const restarted = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('must not execute on recovery')),
      durableHarnessMode: 'next',
    });
    createdRunners.push(restarted);

    const recovery = await restarted.recoverDurableRun!(first.sessionId, first.runId);
    expect(recovery.actions).toContainEqual(expect.objectContaining({
      kind: 'effect_marked_unknown',
      reason: 'effect_settlement_unknown',
    }));
    expect(recovery.projection.pendingEffectIds).toEqual([]);
    expect(recovery.projection.unknownEffectIds.length).toBeGreaterThan(0);
    expect(recovery.projection.status).toBe('failed');
    expect(toolCalls).toBe(1);
    expect((await restarted.replayDurableFinalReply!(first.sessionId, first.runId)).kind).not.toBe('settled');

    const secondRecovery = await restarted.recoverDurableRun!(first.sessionId, first.runId);
    expect(secondRecovery.actions).toEqual([]);
    expect(toolCalls).toBe(1);
  });

  it('settles a pending effect from the host outcome query during restart recovery', async () => {
    const workspace = join(dataDir, 'effect-outcome-query-workspace');
    mkdirSync(workspace, { recursive: true });
    let toolCalls = 0;
    const mutateProbe: AgentTool = {
      name: 'mutate_probe',
      description: 'Perform one durable mutation whose settlement may be lost.',
      inputSchema: { parse: (input) => input, jsonSchema: { type: 'object' } },
      execution: {
        concurrency: 'exclusive',
        resources: () => [{ key: 'workspace:outcome-query', mode: 'write' }],
      },
      async execute() {
        toolCalls += 1;
        writeFileSync(join(workspace, 'outcome-query.txt'), 'mutation completed', 'utf8');
        return { callId: '', ok: true, output: 'mutation completed' };
      },
    };
    let toolCallIssued = false;
    const llm = makeMockLlm((request) => {
      const serialized = JSON.stringify(request.messages);
      if (serialized.includes('Choose the next LittleSheep activity')) {
        return textResponse('{"type":"problem","confidence":0.99,"reason":"execute the mutating probe"}');
      }
      if (serialized.includes('You are the RECOVER stage')) {
        return textResponse('{"action":"abort","reason":"the effect settlement is missing"}');
      }
      if (serialized.includes('You are the VERIFY stage')) {
        return textResponse('{"verdict":"fail","reason":"the effect was not durably settled"}');
      }
      if (serialized.includes('You are the DECIDE stage')) {
        return textResponse('{"plan":[{"description":"run the mutating probe","tools":["mutate_probe"]}]}');
      }
      if (!toolCallIssued && !request.messages.some((message) => message.role === 'tool')) {
        toolCallIssued = true;
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'outcome-query-call',
            type: 'function',
            function: { name: 'mutate_probe', arguments: '{}' },
          }],
        };
      }
      if (request.messages.some((message) => message.role === 'tool')) {
        return textResponse('The mutation was not durably settled.');
      }
      return textResponse('{"type":"problem","confidence":0.99,"reason":"execute the mutating probe"}');
    });
    const firstRunner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      durableHarnessMode: 'next',
    });
    createdRunners.push(firstRunner);
    const append = firstRunner.infra.durableEventStore.append.bind(firstRunner.infra.durableEventStore);
    let settlementFailures = 0;
    vi.spyOn(firstRunner.infra.durableEventStore, 'append').mockImplementation(async (input) => {
      if (input.type === 'effect_settled' && settlementFailures++ === 0) {
        throw new Error('settlement receipt disk full');
      }
      return append(input);
    });

    const first = await firstRunner.run({
      runId: 'run-effect-outcome-query',
      text: 'run the mutating probe',
      cwd: workspace,
      additionalTools: [mutateProbe],
    });
    expect(toolCalls).toBe(1);
    const beforeRestart = reduceDurableRunProjection(
      await firstRunner.infra.durableEventStore.read(String(first.sessionId), first.runId),
    );
    expect(beforeRestart.pendingEffectIds.length).toBeGreaterThan(0);
    await firstRunner.shutdown();
    createdRunners.pop();

    const queried: string[] = [];
    const restarted = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('must not execute on recovery')),
      durableHarnessMode: 'next',
      queryDurableEffectOutcome: async (effect) => {
        queried.push(effect.effectId);
        return { known: true, status: 'succeeded', evidenceRef: 'external:reconciled' };
      },
    });
    createdRunners.push(restarted);

    const recovery = await restarted.recoverDurableRun!(first.sessionId, first.runId);
    expect(queried.length).toBeGreaterThan(0);
    expect(recovery.actions).toContainEqual(expect.objectContaining({
      kind: 'effect_settled',
      status: 'succeeded',
    }));
    expect(recovery.projection.pendingEffectIds).toEqual([]);
    expect(recovery.projection.unknownEffectIds).toEqual([]);
    expect(recovery.projection.effects.some((effect) => (
      effect.status === 'succeeded' && effect.evidenceRef === 'external:reconciled'
    ))).toBe(true);
    expect(toolCalls).toBe(1);
    expect((await restarted.replayDurableFinalReply!(first.sessionId, first.runId)).kind).not.toBe('settled');
  });

  it('keeps a pending effect unknown when the host denies reconciliation reads', async () => {
    const workspace = join(dataDir, 'effect-reconciler-denied-workspace');
    mkdirSync(workspace, { recursive: true });
    let toolCalls = 0;
    const mutateProbe: AgentTool = {
      name: 'mutate_probe',
      description: 'Perform one durable mutation whose settlement may be lost.',
      inputSchema: { parse: (input) => input, jsonSchema: { type: 'object' } },
      execution: {
        concurrency: 'exclusive',
        resources: () => [{ key: 'workspace:reconciler-denied', mode: 'write' }],
      },
      async execute() {
        toolCalls += 1;
        writeFileSync(join(workspace, 'denied.txt'), 'mutation completed', 'utf8');
        return { callId: '', ok: true, output: 'mutation completed' };
      },
    };
    let toolCallIssued = false;
    const llm = makeMockLlm((request) => {
      const serialized = JSON.stringify(request.messages);
      if (serialized.includes('Choose the next LittleSheep activity')) {
        return textResponse('{"type":"problem","confidence":0.99,"reason":"execute the mutating probe"}');
      }
      if (serialized.includes('You are the RECOVER stage')) {
        return textResponse('{"action":"abort","reason":"the effect settlement is missing"}');
      }
      if (serialized.includes('You are the VERIFY stage')) {
        return textResponse('{"verdict":"fail","reason":"the effect was not durably settled"}');
      }
      if (serialized.includes('You are the DECIDE stage')) {
        return textResponse('{"plan":[{"description":"run the mutating probe","tools":["mutate_probe"]}]}');
      }
      if (!toolCallIssued && !request.messages.some((message) => message.role === 'tool')) {
        toolCallIssued = true;
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'reconciler-denied-call',
            type: 'function',
            function: { name: 'mutate_probe', arguments: '{}' },
          }],
        };
      }
      if (request.messages.some((message) => message.role === 'tool')) {
        return textResponse('The mutation was not durably settled.');
      }
      return textResponse('{"type":"problem","confidence":0.99,"reason":"execute the mutating probe"}');
    });
    const firstRunner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      durableHarnessMode: 'next',
    });
    createdRunners.push(firstRunner);
    firstRunner.infra.registry.register(mutateProbe, 'run-scoped');
    const append = firstRunner.infra.durableEventStore.append.bind(firstRunner.infra.durableEventStore);
    let settlementFailures = 0;
    vi.spyOn(firstRunner.infra.durableEventStore, 'append').mockImplementation(async (input) => {
      if (input.type === 'effect_settled' && settlementFailures++ === 0) {
        throw new Error('settlement receipt disk full');
      }
      return append(input);
    });

    const first = await firstRunner.run({
      runId: 'run-effect-reconciler-denied',
      text: 'run the mutating probe',
      cwd: workspace,
    });
    expect(toolCalls).toBe(1);
    await firstRunner.shutdown();
    createdRunners.pop();

    let reconcileCalled = false;
    let sawAuthorizeRead = false;
    const restarted = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('must not execute on recovery')),
      durableHarnessMode: 'next',
      authorizeDurableEffectRead: async () => false,
    });
    createdRunners.push(restarted);
    restarted.infra.registry.register({
      name: 'mutate_probe',
      description: 'probe whose reconciliation read is denied',
      inputSchema: { parse: (input) => input, jsonSchema: { type: 'object' } },
      async execute() {
        throw new Error('recovery must not execute the tool');
      },
      async reconcileEffect(_effect, ctx) {
        reconcileCalled = true;
        sawAuthorizeRead = typeof ctx.authorizeRead === 'function';
        const allowed = await ctx.authorizeRead?.(join(workspace, 'denied.txt')) ?? false;
        return allowed
          ? { known: true, status: 'succeeded', evidenceRef: 'tool:reconciled' }
          : { known: false, reason: 'reconciliation read was not authorized' };
      },
    }, 'run-scoped');

    const recovery = await restarted.recoverDurableRun!(first.sessionId, first.runId);
    // A refused read can never settle the effect: it stays unknown so the
    // user decides instead of the runtime guessing.
    expect(reconcileCalled).toBe(true);
    expect(sawAuthorizeRead).toBe(true);
    expect(recovery.actions).toContainEqual(expect.objectContaining({
      kind: 'effect_marked_unknown',
      reason: 'effect_settlement_unknown',
    }));
    expect(recovery.projection.pendingEffectIds).toEqual([]);
    expect(recovery.projection.unknownEffectIds.length).toBeGreaterThan(0);
    expect(toolCalls).toBe(1);
  });

  it('reconciles a pending effect through a registered tool reconciler', async () => {
    const workspace = join(dataDir, 'effect-tool-reconciler-workspace');
    mkdirSync(workspace, { recursive: true });
    let toolCalls = 0;
    const mutateProbe: AgentTool = {
      name: 'mutate_probe',
      description: 'Perform one durable mutation whose settlement may be lost.',
      inputSchema: { parse: (input) => input, jsonSchema: { type: 'object' } },
      execution: {
        concurrency: 'exclusive',
        resources: () => [{ key: 'workspace:tool-reconciler', mode: 'write' }],
      },
      // Option A: the tool declares a bounded recovery key that must travel
      // with the effect intent and reach the reconciler after a restart.
      reconciliationKey() {
        return { target: 'tool-reconciler.txt', attempt: 1 };
      },
      async execute() {
        toolCalls += 1;
        writeFileSync(join(workspace, 'tool-reconciler.txt'), 'mutation completed', 'utf8');
        return { callId: '', ok: true, output: 'mutation completed' };
      },
    };
    let toolCallIssued = false;
    const llm = makeMockLlm((request) => {
      const serialized = JSON.stringify(request.messages);
      if (serialized.includes('Choose the next LittleSheep activity')) {
        return textResponse('{"type":"problem","confidence":0.99,"reason":"execute the mutating probe"}');
      }
      if (serialized.includes('You are the RECOVER stage')) {
        return textResponse('{"action":"abort","reason":"the effect settlement is missing"}');
      }
      if (serialized.includes('You are the VERIFY stage')) {
        return textResponse('{"verdict":"fail","reason":"the effect was not durably settled"}');
      }
      if (serialized.includes('You are the DECIDE stage')) {
        return textResponse('{"plan":[{"description":"run the mutating probe","tools":["mutate_probe"]}]}');
      }
      if (!toolCallIssued && !request.messages.some((message) => message.role === 'tool')) {
        toolCallIssued = true;
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'tool-reconciler-call',
            type: 'function',
            function: { name: 'mutate_probe', arguments: '{}' },
          }],
        };
      }
      if (request.messages.some((message) => message.role === 'tool')) {
        return textResponse('The mutation was not durably settled.');
      }
      return textResponse('{"type":"problem","confidence":0.99,"reason":"execute the mutating probe"}');
    });
    const firstRunner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      durableHarnessMode: 'next',
    });
    createdRunners.push(firstRunner);
    firstRunner.infra.registry.register(mutateProbe, 'run-scoped');
    const append = firstRunner.infra.durableEventStore.append.bind(firstRunner.infra.durableEventStore);
    let settlementFailures = 0;
    vi.spyOn(firstRunner.infra.durableEventStore, 'append').mockImplementation(async (input) => {
      if (input.type === 'effect_settled' && settlementFailures++ === 0) {
        throw new Error('settlement receipt disk full');
      }
      return append(input);
    });

    const first = await firstRunner.run({
      runId: 'run-effect-tool-reconciler',
      text: 'run the mutating probe',
      cwd: workspace,
    });
    expect(toolCalls).toBe(1);
    const beforeRestart = reduceDurableRunProjection(
      await firstRunner.infra.durableEventStore.read(String(first.sessionId), first.runId),
    );
    expect(beforeRestart.pendingEffectIds.length).toBeGreaterThan(0);
    await firstRunner.shutdown();
    createdRunners.pop();

    const restartLlm = makeMockLlm(textResponse('must not execute on recovery'));
    const authorizedReads: Array<{ path: string; runId: string }> = [];
    const restarted = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: restartLlm,
      durableHarnessMode: 'next',
      authorizeDurableEffectRead: async (path, identity) => {
        authorizedReads.push({ path, runId: identity.runId });
        return true;
      },
    });
    createdRunners.push(restarted);
    const reconciled: string[] = [];
    const reconciledKeys: unknown[] = [];
    let sawAuthorizeRead = false;
    restarted.infra.registry.register({
      name: 'mutate_probe',
      description: 'registered reconciliation probe',
      inputSchema: { parse: (input) => input, jsonSchema: { type: 'object' } },
      async execute() {
        throw new Error('recovery must not execute the tool');
      },
      async reconcileEffect(effect, ctx) {
        reconciled.push(effect.effectId);
        reconciledKeys.push(ctx.reconciliationKey);
        // Recovery-time inspection must go through the host boundary: the
        // tool may not read the effect target on its own authority.
        sawAuthorizeRead = typeof ctx.authorizeRead === 'function';
        const allowed = await ctx.authorizeRead?.('tool-reconciler.txt') ?? false;
        return allowed
          ? { known: true, status: 'succeeded', evidenceRef: 'tool:reconciled' }
          : { known: false, reason: 'reconciliation read was not authorized' };
      },
    }, 'run-scoped');

    const recovery = await restarted.recoverDurableRun!(first.sessionId, first.runId);
    expect(reconciled.length).toBeGreaterThan(0);
    expect(reconciledKeys[0]).toEqual({ target: 'tool-reconciler.txt', attempt: 1 });
    expect(sawAuthorizeRead).toBe(true);
    expect(authorizedReads).toContainEqual({ path: 'tool-reconciler.txt', runId: 'run-effect-tool-reconciler' });
    expect(recovery.actions).toContainEqual(expect.objectContaining({
      kind: 'effect_settled',
      status: 'succeeded',
    }));
    expect(recovery.projection.unknownEffectIds).toEqual([]);
    expect(recovery.projection.effects.some((effect) => (
      effect.status === 'succeeded' && effect.evidenceRef === 'tool:reconciled'
    ))).toBe(true);
    expect(toolCalls).toBe(1);
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

  it('uses one compaction response for the session summary and durable memory candidates', async () => {
    await createMemoryV3ExperimentMarker(dataDir);
    const config = structuredClone(DEFAULT_CONFIG);
    config.memory.repositoryBackend = 'v3';
    config.sessions.compaction.threshold = 2;
    config.sessions.compaction.keepRecent = 1;
    let compactionCalls = 0;
    const llm = makeMockLlm((request) => {
      const system = String(request.messages[0]?.content ?? '');
      if (!system.includes('versioned session summary')) return textResponse('Preference recorded.');
      compactionCalls += 1;
      const transcript = String(request.messages[1]?.content ?? '');
      const sourceMessageId = /\[source message ([^ |]+)/u.exec(transcript)?.[1] ?? '';
      return textResponse(JSON.stringify({
        summary: 'The user prefers concise replies.',
        candidates: [{
          branch: 'long-term',
          scope: 'global',
          summary: 'Concise reply preference',
          content: 'The user prefers concise replies.',
          retrievalKeys: ['concise', 'reply', 'preference'],
          sourceMessageIds: [sourceMessageId],
          importance: 0.9,
          confidence: 0.9,
          reason: 'The user explicitly stated a durable response preference.',
          epistemic: { domain: 'user', statementKind: 'preference', assertedBy: { kind: 'user', id: 'user' } },
        }],
      }));
    });
    const runner = await createRunner({ config, branding: DEFAULT_BRANDING, model: 'openai/gpt-test', llm });
    createdRunners.push(runner);

    const result = await runner.run({ text: 'Please remember that I prefer concise replies.' });
    const summary = (await runner.sessionManager.loadMetadata(result.sessionId))?.compaction;
    expect(compactionCalls).toBe(1);
    expect(summary?.summary).toContain('prefers concise replies');
    expect(await runner.sessionManager.listPendingCompactions(result.sessionId)).toEqual([]);
    const nodes = await runner.infra.memoryRepository.listNodes('long-term');
    expect(nodes).toEqual(expect.arrayContaining([expect.objectContaining({
      summary: 'Concise reply preference',
      sourceRunIds: [result.runId],
    })]));
    // C07: the compaction is owned by one scheduler operation, not an anonymous finalize side effect.
    expect(runner.compactionOperations?.()).toMatchObject([{
      sessionId: String(result.sessionId),
      status: 'completed',
      result: 'compacted',
      force: false,
      usage: { requestCount: 1, usageStatus: 'unavailable' },
    }]);
    // Off the run's critical path: the published run evidence excludes the derived compaction request.
    expect((result.modelRequests ?? []).some((request) => request.callContract?.purpose === 'session_compaction'))
      .toBe(false);
    // The operation is also durably recorded per session for history projection.
    await expect(runner.compactionOperationHistory?.(result.sessionId)).resolves.toMatchObject([{
      sessionId: String(result.sessionId),
      status: 'completed',
      result: 'compacted',
    }]);
  });

  // C10A: a proposal committed before a crash is settled from durable state, without another model call.
  it('resumes a committed compaction proposal without re-running the compaction model', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.sessions.compaction.threshold = 100;
    config.sessions.compaction.keepRecent = 20;
    const { sessionId, summaryId } = await seedCommittedCompactionProposal(
      dataSubdirs(DEFAULT_BRANDING).sessions,
      'crash-resume',
    );

    let compactionCalls = 0;
    const llm = makeMockLlm((request) => {
      if (String(request.messages[0]?.content ?? '').includes('versioned session summary')) compactionCalls += 1;
      return textResponse('Resumed without new learning.');
    });
    const runner = await createRunner({ config, branding: DEFAULT_BRANDING, model: 'openai/gpt-test', llm });
    createdRunners.push(runner);

    const result = await runner.run({ sessionId, text: 'continue after restart' });
    expect(result.status).toBe('ok');
    expect(compactionCalls).toBe(0);
    expect(await runner.sessionManager.listPendingCompactions(sessionId)).toEqual([]);
    expect((await runner.sessionManager.loadMetadata(sessionId))?.compaction?.id).toBe(summaryId);
    const nodes = await runner.infra.memoryRepository.listNodes('long-term');
    expect(nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: 'crash-resume durable candidate' }),
    ]));
  });

  // C10A: a failed source/summary registration keeps the proposal pending and retries on the next run.
  it('keeps a proposal pending when summary registration fails and settles it on the next run', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.sessions.compaction.threshold = 100;
    config.sessions.compaction.keepRecent = 20;
    const { sessionId, summaryId } = await seedCommittedCompactionProposal(
      dataSubdirs(DEFAULT_BRANDING).sessions,
      'registration-retry',
    );

    let replyIndex = 0;
    const llm = makeMockLlm(() => textResponse(`Registration retry reply ${replyIndex += 1}.`));
    const runner = await createRunner({ config, branding: DEFAULT_BRANDING, model: 'openai/gpt-test', llm });
    createdRunners.push(runner);

    const registration = vi.spyOn(runner.infra.memoryService, 'registerSessionSummary')
      .mockRejectedValueOnce(new Error('summary resource registration unavailable'));
    const first = await runner.run({ sessionId, text: 'first continuation' });
    expect(first.status).toBe('ok');
    expect(await runner.sessionManager.listPendingCompactions(sessionId)).toHaveLength(1);
    expect((await runner.infra.memoryRepository.snapshot()).writeAudit).toEqual([]);

    registration.mockRestore();
    const second = await runner.run({ sessionId, text: 'second continuation' });
    expect(second.status).toBe('ok');
    expect(await runner.sessionManager.listPendingCompactions(sessionId)).toEqual([]);
    expect((await runner.sessionManager.loadMetadata(sessionId))?.compaction?.id).toBe(summaryId);
    const nodes = await runner.infra.memoryRepository.listNodes('long-term');
    expect(nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: 'registration-retry durable candidate' }),
    ]));
  });

  // C08A/HC-13: authoritative source capture failure is surfaced in the result, not hidden behind a warn log.
  it('surfaces conversation source capture degradation in the run result', async () => {
    const llm = makeMockLlm([
      textResponse('{"type":"problem","confidence":0.99,"reason":"note the launch code"}'),
      textResponse('{"plan":[{"description":"acknowledge the launch code","tools":[]}]}'),
      textResponse('The launch code is LS-SOURCE-CAPTURE-OK.'),
      textResponse('Understood: the launch code is LS-SOURCE-CAPTURE-OK.'),
      textResponse('{"verdict":"pass","reason":"the launch code was acknowledged"}'),
    ]);
    const runner = await createRunner({ config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING, model: 'openai/gpt-test', llm });
    createdRunners.push(runner);
    const capture = vi.spyOn(runner.infra.memoryService, 'captureConversationSources')
      .mockRejectedValueOnce(new Error('source store unavailable'));

    const result = await runner.run({ text: 'For this chat only, the launch code is LS-SOURCE-CAPTURE-OK.' });
    expect(result.status).toBe('ok');
    expect(result.memorySourceCapture).toEqual({ status: 'degraded', reason: 'source store unavailable' });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  // HC-07: an invalid compaction proposal has bounded attempts, preserves the transcript, and commits no candidate.
  it('keeps the previous transcript when a compaction proposal cites an uncovered source', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.sessions.compaction.threshold = 2;
    config.sessions.compaction.keepRecent = 1;
    const sessionsDir = dataSubdirs(DEFAULT_BRANDING).sessions;
    const seedManager = new SessionManager({ sessionsDir });
    const session = await seedManager.create('openai/gpt-test');
    await seedManager.append(session.id, Array.from({ length: 4 }, (_, index) => textMessage(
      index % 2 === 0 ? 'user' : 'assistant',
      `seed message ${index + 1}`,
      { id: `invalid-seed-${index + 1}`, runId: `invalid-run-${Math.floor(index / 2) + 1}` },
    )));
    const before = await seedManager.read(session.id);

    let compactionCalls = 0;
    const llm = makeMockLlm((request) => {
      if (String(request.messages[0]?.content ?? '').includes('versioned session summary')) {
        compactionCalls += 1;
        return textResponse(JSON.stringify({
          summary: 'Invalid proposal that must not persist.',
          candidates: [{
            branch: 'long-term',
            scope: 'global',
            summary: 'Unauthorized candidate',
            content: 'This candidate cites a source outside the covered prefix.',
            retrievalKeys: ['unauthorized'],
            sourceMessageIds: ['not-a-covered-message'],
            importance: 0.8,
            confidence: 0.9,
            reason: 'Synthetic invalid compaction candidate.',
          }],
        }));
      }
      return textResponse('Acknowledged.');
    });
    const runner = await createRunner({ config, branding: DEFAULT_BRANDING, model: 'openai/gpt-test', llm });
    createdRunners.push(runner);

    const result = await runner.run({ sessionId: session.id, text: 'continue the seeded task' });
    expect(result.status).toBe('ok');
    // decode/schema retries stay bounded at two total attempts.
    expect(compactionCalls).toBe(2);
    expect((await runner.sessionManager.loadMetadata(session.id))?.compaction).toBeUndefined();
    expect(await runner.sessionManager.listPendingCompactions(session.id)).toEqual([]);
    const after = await runner.sessionManager.read(session.id);
    expect(after.slice(0, before.length).map((message) => message.id)).toEqual(before.map((message) => message.id));
    expect(runner.compactionOperations?.()).toMatchObject([{ status: 'failed' }]);
  });

  // HC-18: the legacy plain-text compaction protocol still produces a summary.
  it('keeps plain-text compaction summaries working for legacy callers', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.sessions.compaction.threshold = 2;
    config.sessions.compaction.keepRecent = 1;
    const seedManager = new SessionManager({ sessionsDir: dataSubdirs(DEFAULT_BRANDING).sessions });
    const session = await seedManager.create('openai/gpt-test');
    await seedManager.append(session.id, Array.from({ length: 4 }, (_, index) => textMessage(
      index % 2 === 0 ? 'user' : 'assistant',
      `legacy seed ${index + 1}`,
      { id: `legacy-seed-${index + 1}`, runId: `legacy-run-${Math.floor(index / 2) + 1}` },
    )));
    const llm = makeMockLlm((request) => (
      String(request.messages[0]?.content ?? '').includes('versioned session summary')
        ? textResponse('Legacy plain-text summary without candidates.')
        : textResponse('Acknowledged.')
    ));
    const runner = await createRunner({ config, branding: DEFAULT_BRANDING, model: 'openai/gpt-test', llm });
    createdRunners.push(runner);

    const result = await runner.run({ sessionId: session.id, text: 'continue the legacy task' });
    expect(result.status).toBe('ok');
    const summary = (await runner.sessionManager.loadMetadata(session.id))?.compaction;
    expect(summary?.summary).toContain('Legacy plain-text summary');
    expect(await runner.sessionManager.listPendingCompactions(session.id)).toEqual([]);
  });

  // HC-17: an independent oracle inspects the real model request after shrinkage.
  it('keeps an exact fact reachable from the summary after history shrinkage', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.sessions.compaction.threshold = 2;
    config.sessions.compaction.keepRecent = 1;
    const seedManager = new SessionManager({ sessionsDir: dataSubdirs(DEFAULT_BRANDING).sessions });
    const session = await seedManager.create('openai/gpt-test');
    await seedManager.append(session.id, [
      textMessage('user', '请记住代号是 HC17-ORACLE-77。本轮只回复“记录完成”。', { id: 'oracle-1', runId: 'oracle-run-1' }),
      textMessage('assistant', '记录完成', { id: 'oracle-2', runId: 'oracle-run-1' }),
      textMessage('user', '继续。', { id: 'oracle-3', runId: 'oracle-run-2' }),
    ]);
    const requests: string[] = [];
    let replyCount = 0;
    const llm = makeMockLlm((request) => {
      requests.push(JSON.stringify(request.messages));
      const system = String(request.messages[0]?.content ?? '');
      if (system.includes('versioned session summary')) {
        return textResponse('HC17 摘要：用户要求记住代号 HC17-ORACLE-77。');
      }
      if (system.includes('You are the VERIFY stage')) {
        return textResponse('{"verdict":"pass","reason":"the code was carried from the summary"}');
      }
      return textResponse(`HC17-ORACLE-77（第 ${++replyCount} 次确认）。`);
    });
    const runner = await createRunner({ config, branding: DEFAULT_BRANDING, model: 'openai/gpt-test', llm });
    createdRunners.push(runner);

    const first = await runner.run({ sessionId: session.id, text: '继续。' });
    expect(first.status).toBe('ok');
    expect((await runner.sessionManager.loadMetadata(session.id))?.compaction?.summary)
      .toContain('HC17-ORACLE-77');

    // Independent oracle: the exact fact must appear in a real request while the
    // original wording is gone from the recent window.
    requests.length = 0;
    const second = await runner.run({ sessionId: session.id, text: '代号是什么？只回答代号。' });
    expect(second.status).toBe('ok');
    const injected = requests.join('\n');
    expect(injected).toContain('HC17-ORACLE-77');
    expect(injected).not.toContain('本轮只回复');
  });

  // C07: opt-in background compaction publishes the run first and owns its own usage.
  it('publishes the run before an opt-in background compaction finishes', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.sessions.compaction.threshold = 2;
    config.sessions.compaction.keepRecent = 1;
    config.sessions.compaction.background = true;
    const seedManager = new SessionManager({ sessionsDir: dataSubdirs(DEFAULT_BRANDING).sessions });
    const session = await seedManager.create('openai/gpt-test');
    await seedManager.append(session.id, Array.from({ length: 3 }, (_, index) => textMessage(
      index % 2 === 0 ? 'user' : 'assistant',
      `background seed ${index + 1}`,
      { id: `background-seed-${index + 1}`, runId: `background-run-${Math.floor(index / 2) + 1}` },
    )));
    let compactionCalls = 0;
    const llm = makeMockLlm((request) => {
      if (String(request.messages[0]?.content ?? '').includes('versioned session summary')) {
        compactionCalls += 1;
        return textResponse(JSON.stringify({ summary: 'Background summary.', candidates: [] }));
      }
      return textResponse('Acknowledged.');
    });
    const runner = await createRunner({ config, branding: DEFAULT_BRANDING, model: 'openai/gpt-test', llm });
    createdRunners.push(runner);

    const result = await runner.run({ sessionId: session.id, text: 'continue in the background' });
    expect(result.status).toBe('ok');
    const publishedRequests = (result.modelRequests ?? []).length;
    const publishedUsage = JSON.stringify(result.usage ?? null);
    expect((result.modelRequests ?? []).some((request) => request.callContract?.purpose === 'session_compaction'))
      .toBe(false);

    await runner.drainCompaction?.();
    expect(compactionCalls).toBeGreaterThanOrEqual(1);
    // The detached accounting context cannot rewrite the already published run.
    expect((result.modelRequests ?? []).length).toBe(publishedRequests);
    expect(JSON.stringify(result.usage ?? null)).toBe(publishedUsage);
    expect((await runner.sessionManager.loadMetadata(session.id))?.compaction?.summary).toContain('Background summary');
    expect(await runner.sessionManager.listPendingCompactions(session.id)).toEqual([]);
    expect(runner.compactionOperations?.()).toMatchObject([expect.objectContaining({ status: 'completed', result: 'compacted' })]);
  });

  // C09: every follow-up request records why its context prefix changed, without exporting any body text.
  it('records a redacted prefix-change reason on follow-up model requests', async () => {
    const marker = 'LS-PREFIX-CHANGE-MARKER';
    const llm = makeMockLlm([
      textResponse('{"type":"problem","confidence":0.99,"reason":"note the marker"}'),
      textResponse('{"plan":[{"description":"acknowledge the marker","tools":[]}]}'),
      textResponse(`Noted ${marker}.`),
      textResponse(`Understood: ${marker}.`),
      textResponse('{"verdict":"pass","reason":"the marker was acknowledged"}'),
    ]);
    const runner = await createRunner({ config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING, model: 'openai/gpt-test', llm });
    createdRunners.push(runner);

    const result = await runner.run({ text: `For this chat only, note ${marker}.` });
    expect(result.status).toBe('ok');
    const changed = (result.modelRequests ?? []).filter((request) => request.prefixChange !== undefined);
    expect(changed.length).toBeGreaterThan(0);
    const change = changed.at(-1)!.prefixChange!;
    expect(change.changedSegments).toBeGreaterThan(0);
    expect(change.reasons.length).toBeGreaterThan(0);
    expect(change.stablePrefixLength).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(change)).not.toContain(marker);
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

  it('streams and settles a next-harness reply with partial provider usage', async () => {
    const llm = makeMockLlm({
      ...textResponse('Next stream reply!'),
      usage: { promptTokens: 80, completionTokens: 8 },
    });
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      durableHarnessMode: 'next',
    });
    createdRunners.push(runner);
    const deltas: string[] = [];

    const result = await runner.runStream({ text: 'hello next stream' }, (delta) => deltas.push(delta));

    expect(result.status).toBe('ok');
    expect(result.reply).toBe('Next stream reply!');
    expect(deltas.join('')).toBe('Next stream reply!');
    expect(result.finalReplySettlement?.status).toBe('settled');
    const events = await runner.infra.durableEventStore.read(String(result.sessionId), result.runId);
    expect(events.filter((event) => event.type === 'model_response_received').length).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === 'model_request_settled').length).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === 'final_reply_settled')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'run_completed')).toHaveLength(1);
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

  it('records an aborted provider call without fabricating cache usage', async () => {
    const ac = new AbortController();
    let markCallStarted!: () => void;
    const callStarted = new Promise<void>((resolve) => { markCallStarted = resolve; });
    const llm = makeMockLlm(textResponse('unused'));
    (llm.chat as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      markCallStarted();
      await new Promise<never>((_resolve, reject) => {
        ac.signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
      });
      return textResponse('unused');
    });
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      durableHarnessMode: 'next',
    });
    createdRunners.push(runner);
    const runId = 'run-aborted-provider';
    const running = runner.run({ runId, text: 'hello', signal: ac.signal });
    await callStarted;
    ac.abort();
    const result = await running;
    expect(result.status).toBe('aborted');

    const events = await runner.infra.durableEventStore.read(String(result.sessionId), runId);
    const request = reduceDurableRunProjection(events).modelRequests[0];
    expect(request).toMatchObject({
      status: 'aborted',
      providerReachStatus: 'not_reached',
      usageStatus: 'unavailable',
      transportStatus: 'aborted',
    });
    expect(request?.cacheObservation?.providerPrompt).toMatchObject({
      status: 'unavailable',
      reason: 'provider_request_aborted',
    });
    expect(request?.providerUsage).toBeUndefined();
  });

  it('settles next-harness provider timeouts without leaving pending model requests', async () => {
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(() => { throw new Error('provider timeout'); }),
      durableHarnessMode: 'next',
    });
    createdRunners.push(runner);

    const result = await runner.run({ text: 'next provider timeout' });
    expect(result.status).toBe('error');
    const events = await runner.infra.durableEventStore.read(String(result.sessionId), result.runId);
    const settlements = events.filter((event) => event.type === 'model_request_settled');
    expect(settlements.length).toBeGreaterThan(0);
    expect(settlements.every((event) => event.payload.status === 'timeout')).toBe(true);
    expect(events.some((event) => event.type === 'run_failed')).toBe(true);
    expect(events.some((event) => event.type === 'run_completed')).toBe(false);
    expect(reduceDurableRunProjection(events).pendingModelRequestIds).toEqual([]);
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

  // HC-15: a late runtime event must not reopen or rewrite an already settled run.
  it('ignores a runtime event that arrives after the run already settled', async () => {
    const llm = makeMockLlm([
      textResponse('{"type":"problem","confidence":0.99,"reason":"note the marker"}'),
      textResponse('{"plan":[{"description":"acknowledge the marker","tools":[]}]}'),
      textResponse('Noted LS-LATE-EVENT.'),
      textResponse('Understood: LS-LATE-EVENT.'),
      textResponse('{"verdict":"pass","reason":"the marker was acknowledged"}'),
    ]);
    const runner = await createRunner({ config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING, model: 'openai/gpt-test', llm });
    createdRunners.push(runner);
    const runId = 'run-late-event';
    const result = await runner.run({ runId, text: 'For this chat only, note LS-LATE-EVENT.' });
    expect(result.status).toBe('ok');
    const before = await runner.replay(runId);

    const outcome = runner.runtimeEvents.append(runId, {
      type: 'interrupt_requested',
      source: 'app',
      payload: { reason: 'late stop' },
      dedupKey: 'late:1',
    });

    expect(['expired', 'rejected']).toContain(outcome.kind);
    expect(runner.runtimeEvents.summary(runId)).toBeNull();
    const after = await runner.replay(runId);
    expect(after?.status).toBe('ok');
    expect(after?.runtimeControl).toEqual(before?.runtimeControl);
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
      request.messages.map((message) => String(message.content)).join('\n')
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
    // HC-18: per-run EVOLVE/CAPTURE persistence is only reachable when the legacy policy is explicit.
    const config = structuredClone(DEFAULT_CONFIG);
    config.memory.autoMemoryPolicy = 'legacy-per-run';
    const runner = await createRunner({ config, branding: DEFAULT_BRANDING, model: 'test/model', llm });
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

/**
 * C10A fixture: commit a summary plus a bounded candidate proposal and crash before settlement.
 * The session store keeps the v2 pending transaction so a later Runner can settle it from disk.
 */
async function seedCommittedCompactionProposal(
  sessionsDir: string,
  marker: string,
): Promise<{ sessionId: SessionId; summaryId: string }> {
  const manager = new SessionManager({ sessionsDir });
  const session = await manager.create('openai/gpt-test');
  const messages = Array.from({ length: 4 }, (_, index) => textMessage(
    index % 2 === 0 ? 'user' : 'assistant',
    `${marker} seed ${index + 1}`,
    {
      id: `${marker}-seed-${index + 1}`,
      runId: `${marker}-run-${Math.floor(index / 2) + 1}`,
      timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    },
  ));
  await manager.append(session.id, messages);
  const summary = await maybeCompact(manager, session.id, {
    threshold: 1,
    keepRecent: 1,
    summarize: async () => ({
      summary: `${marker} seeded summary awaiting candidate settlement.`,
      memoryEvidenceComplete: true,
      memoryCandidates: [{
        id: `${marker}-candidate`,
        branch: 'long-term' as const,
        parentNodeId: 'long-term:root',
        scope: 'global' as const,
        summary: `${marker} durable candidate`,
        content: `Durable candidate created by ${marker}.`,
        retrievalKeys: [marker, 'durable'],
        sourceMessageIds: [`${marker}-seed-1`],
        importance: 0.8,
        confidence: 0.9,
        reason: 'Synthetic candidate for the crash-resume contract.',
      }],
    }),
  });
  if (!summary) throw new Error('Expected a seeded compaction summary.');
  return { sessionId: session.id, summaryId: summary.id };
}
