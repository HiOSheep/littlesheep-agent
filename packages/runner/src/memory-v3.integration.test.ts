import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm';
import { createMemoryV3ExperimentMarker, InjectionTier } from '@littlesheep/memory-tree';
import { asSessionId } from '@littlesheep/types';
import { createRunner, type AgentRunner } from './runner.js';

describe('Runner Memory v3 integration', () => {
  let dataDir: string;
  const runners: AgentRunner[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ls-runner-memory-v3-'));
    process.env.LITTLESHEEP_DATA_DIR = dataDir;
    await createMemoryV3ExperimentMarker(dataDir);
  });

  afterEach(async () => {
    for (const runner of runners.splice(0)) await runner.shutdown().catch(() => undefined);
    delete process.env.LITTLESHEEP_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('persists EVOLVE and CAPTURE atoms, navigates them, and restores them after restart', async () => {
    const workspace = join(dataDir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const config = {
      ...DEFAULT_CONFIG,
      memory: { ...DEFAULT_CONFIG.memory, repositoryBackend: 'v3' as const },
    };
    const first = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm([
        textResponse('{"type":"problem","confidence":0.9,"reason":"task"}'),
        textResponse('{"plan":[{"description":"inspect it","tools":[]}]}'),
        textResponse('Inspection complete.'),
        textResponse('{"verdict":"pass","reason":"goal achieved"}'),
        textResponse(JSON.stringify({ memories: [{
          branch: 'project',
          parentNodeId: 'project:root',
          scope: 'workspace',
          summary: 'Repository uses pnpm',
          content: 'Use pnpm commands in this workspace.',
          retrievalKeys: ['pnpm', 'workspace'],
          importance: 0.8,
          confidence: 0.95,
          reason: 'Verified from the repository configuration.',
        }], createSkill: null })),
        textResponse(JSON.stringify({ observations: [{
          summary: 'Inspection completed',
          content: 'The requested repository inspection completed successfully.',
          retrievalKeys: ['inspection', 'completed'],
          importance: 0.4,
          confidence: 0.9,
          reason: 'Useful for reconstructing this run.',
        }] })),
      ]),
      skillsDirs: [],
    });
    runners.push(first);

    const result = await first.run({ text: 'read the file', cwd: workspace });
    expect(result.status).toBe('ok');
    const projectNodes = await first.infra.memoryRepository.listNodes('project', workspace);
    const dailyNodes = await first.infra.memoryRepository.listNodes('daily', workspace);
    expect(projectNodes).toHaveLength(1);
    expect(dailyNodes).toHaveLength(1);
    expect(projectNodes[0]).toMatchObject({ summary: 'Repository uses pnpm', sourceRunIds: [result.runId] });
    expect(dailyNodes[0]).toMatchObject({ summary: 'Inspection completed', sourceRunIds: [result.runId] });
    expect(await countFiles(join(dataDir, 'memory-tree', 'v3', 'atoms'), '.memory.json')).toBeGreaterThanOrEqual(2);

    await first.shutdown();
    runners.splice(runners.indexOf(first), 1);
    const restored = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('unused')),
      skillsDirs: [],
    });
    runners.push(restored);

    expect(await restored.infra.memoryRepository.getNode(projectNodes[0]!.id)).toMatchObject({
      summary: 'Repository uses pnpm',
    });
    expect(await restored.infra.memoryRepository.getNode(dailyNodes[0]!.id)).toMatchObject({
      summary: 'Inspection completed',
    });

    const navigationRunId = 'memory-v3-navigation';
    await restored.infra.memoryService.beginRun({
      runId: navigationRunId,
      sessionId: asSessionId('memory-v3-session'),
      query: 'pnpm workspace',
      recentHistory: [],
      workspace,
      autoPrime: false,
    });
    const index = await restored.infra.memoryService.branchIndex(navigationRunId, 'project');
    expect(index.entries.map((entry) => entry.id)).toContain(projectNodes[0]!.id);
    const expansion = await restored.infra.memoryService.expand(navigationRunId, {
      branchId: 'project',
      nodeId: projectNodes[0]!.id,
      limit: 5,
      tokenBudget: 800,
    });
    expect(expansion.fragments[0]).toMatchObject({
      id: projectNodes[0]!.id,
      metadata: { source: `memory-v3:atom:${projectNodes[0]!.id}` },
    });
    await restored.infra.memoryService.finishRun(navigationRunId);
  });

  it('injects a D1-selected atom into the first business model request', async () => {
    const workspace = join(dataDir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const requests: ChatRequest[] = [];
    const runner = await createRunner({
      config: {
        ...DEFAULT_CONFIG,
        memory: { ...DEFAULT_CONFIG.memory, repositoryBackend: 'v3' as const },
      },
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('Hello from LS.'), requests),
      skillsDirs: [],
    });
    runners.push(runner);
    const write = await runner.infra.memoryService.write({
      id: 'initial-greeting-memory',
      branch: 'long-term',
      parentNodeId: 'long-term:root',
      scope: 'global',
      tier: InjectionTier.T2_RELEVANT,
      summary: 'User greeting preference',
      content: 'The user prefers concise greetings.',
      retrievalKeys: ['hello', 'greeting', 'concise'],
      sourceRefs: ['user:explicit-greeting-preference'],
      sourceRunId: 'seed-run',
      sourceStage: 'evolve',
      importance: 0.8,
      confidence: 0.9,
      reason: 'Explicit user preference used by the integration test.',
      epistemic: {
        domain: 'user',
        statementKind: 'preference',
        epistemicStatus: 'reported',
        authorityScope: { kind: 'user-self', scope: 'global', topics: ['greeting'] },
        assertedBy: { kind: 'user', id: 'user' },
        evidenceRefs: ['user:explicit-greeting-preference'],
      },
    });
    expect(write).toMatchObject({ decision: 'created', node: { summary: 'User greeting preference' } });
    const result = await runner.run({ text: 'hello', cwd: workspace });
    expect(result.status).toBe('ok');
    const outbound = requests.find((request) => String(request.messages[0]?.content).includes('Initially Selected Memory Atoms'));
    expect(String(outbound?.messages[0]?.content)).toContain('prefers concise greetings');
    expect(result.memoryAccess?.records.map((record) => record.action)).toEqual(expect.arrayContaining([
      'root_index', 'branch_index', 'expand',
    ]));
  });
});

function makeMockLlm(responses: ChatResponse | ChatResponse[], requests?: ChatRequest[]): LlmClient {
  const queue = Array.isArray(responses) ? [...responses] : undefined;
  const single = Array.isArray(responses) ? undefined : responses;
  const fallback = textResponse('');
  const chat = vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
    requests?.push(request);
    return queue?.shift() ?? single ?? fallback;
  });
  const chatStream = vi.fn(async (request: ChatRequest, onDelta: (chunk: StreamChunk) => void) => {
    const response = await chat(request);
    if (response.content) onDelta({ type: 'delta', delta: response.content });
    onDelta({ type: 'done', finishReason: response.finishReason });
    return response;
  });
  return {
    chat,
    chatStream,
    embed: vi.fn(async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } })),
  };
}

function textResponse(content: string): ChatResponse {
  return { content, toolCalls: [], finishReason: 'stop' };
}

async function countFiles(root: string, suffix: string): Promise<number> {
  let count = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(suffix)) count += 1;
    }
  }
  return count;
}
