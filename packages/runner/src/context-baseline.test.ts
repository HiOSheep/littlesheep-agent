import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { buildContextTrace, prepareLocalExactContextTokenCounter } from '@littlesheep/context';
import { buildOpenAICompatibleChatCompletionsBody, type ChatRequest, type LlmClient } from '@littlesheep/llm';
import { createMemoryV3ExperimentMarker, InjectionTier } from '@littlesheep/memory-tree';
import { maybeCompact } from '@littlesheep/session';
import { createRunner } from './runner.js';

/** Real Runner/Harness assembly with synthetic data and a non-billing transport. */
it('CMv2 six-scenario assembly baseline in an isolated data root', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ls-cmv2-'));
  const previousRoot = process.env.LITTLESHEEP_DATA_DIR;
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  const requests: ChatRequest[] = [];
  let toolReadPath: string | undefined;
  const llm: LlmClient = {
    async chat(request) {
      requests.push({ ...request, messages: structuredClone(request.messages), tools: structuredClone(request.tools) });
      if (toolReadPath) {
        const filePath = toolReadPath;
        toolReadPath = undefined;
        return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'fixture-read', type: 'function',
          function: { name: 'read', arguments: JSON.stringify({ file_path: filePath }) } }] };
      }
      return { content: 'Synthetic response.', toolCalls: [], finishReason: 'stop' };
    },
    async chatStream(request) { return this.chat(request); },
    async embed(request) {
      return { model: request.model, embeddings: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0.1, 0.2, 0.3]), usage: { promptTokens: 0 } };
    },
  };
  let runner: Awaited<ReturnType<typeof createRunner>> | undefined;
  try {
    await createMemoryV3ExperimentMarker(dataDir);
    const workspace = join(dataDir, 'workspace');
    await mkdir(workspace);
    const config = structuredClone(DEFAULT_CONFIG);
    config.memory.repositoryBackend = 'v3';
    config.sessions.compaction.threshold = 1000;
    runner = await createRunner({ config, branding: DEFAULT_BRANDING, model: 'test/model', llm, skillsDirs: [] });
    // Optional isolated immutable asset provisioning. Ordinary tests never download.
    const counter = process.env.CMV2_TOKENIZER_ROOT
      ? await prepareLocalExactContextTokenCounter({ modelRef: 'deepseek/deepseek-flash',
          modelRootDir: resolve(process.env.CMV2_TOKENIZER_ROOT), timeoutMs: 60_000 }) : undefined;
    const rows: unknown[] = [];
    async function measure(name: string, input: Parameters<NonNullable<typeof runner>['run']>[0]) {
      requests.length = 0;
      const started = performance.now();
      const result = await runner!.run({ ...input, cwd: workspace });
      const durationMs = performance.now() - started;
      expect(result.status).toBe('ok');
      expect(requests.length).toBeGreaterThan(0);
      const request = requests.at(-1)!;
      const snapshot = result.contextSnapshots!.at(-1)!;
      const modelRequest = result.modelRequests!.find((item) => item.contextSnapshotId === snapshot.id)!;
      const before = performance.now();
      for (let i = 0; i < 1000; i++) buildContextTrace(snapshot, modelRequest);
      const traceMeanMs = (performance.now() - before) / 1000;
      const trace = buildContextTrace(snapshot, modelRequest)!;
      expect(trace).toBeDefined();
      const tokenizerRequest = { ...request, model: 'deepseek-flash', thinking: { type: 'disabled' as const } };
      const total = counter?.countRequest(tokenizerRequest);
      // The calibrated counter deliberately rejects tool history without schemas.
      const hasToolHistory = request.messages.some((message) => message.role === 'tool' || message.tool_calls?.length);
      const noTools = hasToolHistory ? undefined
        : counter?.countRequest({ ...tokenizerRequest, tools: undefined, tool_choice: undefined });
      const systemOnly = counter?.countRequest({ ...tokenizerRequest, messages: [request.messages[0]!], tools: undefined, tool_choice: undefined });
      const headAndUser = counter?.countRequest({ ...tokenizerRequest, messages: request.messages.slice(0, 2), tools: undefined, tool_choice: undefined });
      rows.push({ scenario: name, requests: requests.length, durationMs: Math.round(durationMs),
        traceMeanMs, wireBytes: Buffer.byteLength(JSON.stringify(buildOpenAICompatibleChatCompletionsBody(request, false))),
        toolSchemaCharacters: JSON.stringify(request.tools ?? []).length,
        tokenizer: counter ? { status: 'local-counterfactual', promptTokens: total,
          nativeToolMarginalTokens: noTools === undefined ? undefined : total! - noTools, systemOnlyTokens: systemOnly,
          toolAblation: hasToolHistory ? 'unavailable-tool-history-shape' : 'available',
          noToolsTokens: noTools, firstTwoMessagesTokens: headAndUser } : { status: 'unavailable' }, trace });
      return result;
    }
    const greeting = await measure('greeting', { text: '你好' });
    await measure('multi-turn', { text: '继续聊聊今天的计划', sessionId: greeting.sessionId });
    await writeFile(join(workspace, 'AGENTS.md'), 'Synthetic project: TypeScript desktop application. Run focused tests.');
    await measure('project-question', { text: '解释当前项目的技术栈' });
    toolReadPath = join(workspace, 'AGENTS.md');
    const coding = await measure('coding-agent', { text: '读取 AGENTS.md 并说明修改方案',
      profile: 'coding', approve: async () => true });
    expect(coding.toolInvocations?.some((invocation) => invocation.toolName === 'read' && invocation.status === 'succeeded')).toBe(true);
    expect(coding.contextSnapshots?.some((s) => s.items.some((i) => i.kind === 'tool_result'))).toBe(true);
    const summary = await maybeCompact(runner.infra.sessionManager, greeting.sessionId, {
      threshold: 1, keepRecent: 1, force: true,
      summarize: async () => ({ summary: 'Synthetic continuity: greetings and plans were discussed.', model: 'fixture' }),
    });
    expect(summary).toBeTruthy();
    const compressed = await measure('history-compaction', { text: '继续之前的计划', sessionId: greeting.sessionId });
    expect(compressed.contextSnapshots?.some((s) => s.items.some((i) => i.kind === 'summary_memory'))).toBe(true);
    const written = await runner.infra.memoryService.write({
      id: 'cmv2-fixture-preference', branch: 'long-term', parentNodeId: 'long-term:root', scope: 'global',
      tier: InjectionTier.T2_RELEVANT, summary: 'User greeting preference', content: 'The user prefers concise greetings.',
      retrievalKeys: ['hello', 'greeting', 'concise'], sourceRefs: ['conversation-source:seed-run:user-message:seed-message'],
      sourceRunId: 'seed-run', sourceStage: 'tool', importance: 0.8, confidence: 0.9,
      reason: 'Synthetic baseline fixture.', epistemic: { domain: 'user', statementKind: 'preference',
        epistemicStatus: 'reported', authorityScope: { kind: 'user-self', scope: 'global', topics: ['greeting'] },
        assertedBy: { kind: 'user', id: 'user' }, evidenceRefs: ['user:fixture'] },
    });
    expect(written.node).toBeTruthy();
    const recalled = await measure('memory-retrieval', { text: 'hello' });
    expect(recalled.contextSnapshots?.some((s) => s.items.some((i) => i.kind === 'memory_fragment'))).toBe(true);
    const output = { version: 1, transport: 'mock-no-provider-usage', timing: 'single-sample-warm-process',
      tokenizerModel: counter ? 'deepseek/deepseek-flash' : undefined, rows };
    if (process.env.CMV2_BASELINE_OUTPUT) await writeFile(resolve(process.env.CMV2_BASELINE_OUTPUT), JSON.stringify(output, null, 2));
    console.log('CMV2_BASELINE', JSON.stringify(rows.map((row) => {
      const { trace: _trace, ...summary } = row as { trace: unknown; scenario: string };
      return summary;
    })));
  } finally {
    await runner?.shutdown();
    if (previousRoot === undefined) delete process.env.LITTLESHEEP_DATA_DIR;
    else process.env.LITTLESHEEP_DATA_DIR = previousRoot;
    const target = resolve(dataDir);
    if (!target.startsWith(resolve(join(tmpdir(), 'ls-cmv2-')))) throw new Error('Unexpected fixture cleanup path');
    await rm(target, { recursive: true, force: true });
  }
}, 180_000);
