import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { InMemoryOwnershipBindings, InjectionTier, createMemoryV3ExperimentMarker, memoryAccessRootId,
  memoryNodeAccessRevision, issueMemoryAccessGrant } from '@littlesheep/memory-tree';
import { createRunner, type CreateRunnerOptions } from './runner.js';

it.each(['v2', 'v3'] as const)('real Runner Atom enforcement, revision invalidation and propagation compatibility (%s)', async (backend) => {
  const root = await mkdtemp(join(tmpdir(), 'ls-atom-access-'));
  const previous = process.env.LITTLESHEEP_DATA_DIR;
  process.env.LITTLESHEEP_DATA_DIR = root;
  let runner: Awaited<ReturnType<typeof createRunner>> | undefined;
  let runId = 'enforced-run', current = true;
  const requests: string[] = [];
  let allowedId = '', deniedId = '';
  const llm: NonNullable<CreateRunnerOptions['llm']> = {
    async chat(request) {
      requests.push(JSON.stringify(request.messages));
      if (runId === 'enforced-run') {
        const index = await runner!.infra.memoryService.branchIndex(runId, 'long-term');
        expect(JSON.stringify(index)).not.toContain(deniedId);
        expect(JSON.stringify(index)).not.toContain('PRIVATE_ATOM');
        expect(index.entries.map((item) => item.id)).toEqual([allowedId]);
        const denied = await runner!.infra.memoryService.expand(runId, { branchId: 'long-term', nodeId: deniedId, limit: 2 });
        expect(denied.fragments).toEqual([]);
        expect(denied.childIndex ?? []).toEqual([]);
        expect(JSON.stringify(denied)).not.toContain('PRIVATE_ATOM');
        const node = (await runner!.infra.memoryRepository.getNode(allowedId))!;
        await runner!.infra.memoryRepository.manageNode(allowedId, 'archive', 'Fixture revision change', node.atomRevision);
        const revised = await runner!.infra.memoryService.branchIndex(runId, 'long-term');
        expect(revised.entries).toEqual([]);
        expect(revised.knownState?.references.some((entry) => entry.atomId === allowedId)).not.toBe(true);
        current = false;
        await expect(runner!.infra.memoryService.branchIndex(runId, 'long-term')).rejects.toThrow('authorization unavailable');
        await expect(runner!.infra.memoryService.deepSearch(runId, { branchId: 'long-term', query: 'catalog' })).rejects.toThrow('authorization unavailable');
        await expect(runner!.infra.memoryService.release(runId, [allowedId])).rejects.toThrow('authorization unavailable');
      }
      return { content: 'Synthetic reply.', finishReason: 'stop', toolCalls: [] };
    }, async chatStream(request) { return this.chat(request); },
    async embed(request) { return { model: request.model, embeddings: [[1, 0]], usage: { promptTokens: 0 } }; },
  };
  try {
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    if (backend === 'v3') await createMemoryV3ExperimentMarker(root);
    const config = structuredClone(DEFAULT_CONFIG); config.memory.repositoryBackend = backend;
    const store = new InMemoryOwnershipBindings();
    runner = await createRunner({ config, branding: DEFAULT_BRANDING, model: 'test/model', llm, skillsDirs: [], memoryOwnershipBindings: store });
    const seed = async (id: string, text: string) => runner!.infra.memoryService.write({ id, branch: 'long-term', parentNodeId: 'long-term:root', scope: 'global',
      tier: InjectionTier.T2_RELEVANT, summary: text, content: text, retrievalKeys: ['catalog', 'database'], sourceRefs: [`conversation-source:seed:user-message:${id}`],
      sourceRunId: 'seed', sourceStage: 'tool', importance: 0.8, confidence: 0.9, reason: 'Isolated fixture', epistemic: {
        domain: 'knowledge', statementKind: 'factual-claim', epistemicStatus: 'verified', authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['catalog'] },
        assertedBy: { kind: 'tool', id: 'fixture' }, evidenceRefs: ['tool:fixture'] } });
    const allowed = await seed('allowed', 'AUTHORIZED_ATOM catalog database uses SQLite');
    const denied = await seed('denied', 'PRIVATE_ATOM catalog database uses another storage engine');
    expect(allowed.node).toBeTruthy(); expect(denied.node).toBeTruthy();
    allowedId = allowed.node!.id; deniedId = denied.node!.id;
    const rootId = memoryAccessRootId(root);
    for (const node of [allowed.node!, denied.node!]) store.compareAndSet({ version: 1, revision: 0,
      entityRevision: backend === 'v3' ? `v3:${node.atomRevision}` : memoryNodeAccessRevision(node), target: {
        kind: 'atom', id: node.id, principalId: `local:${rootId}`, dataRootId: rootId, binding: 'reviewed', scope: 'project',
        projectId: node.id === allowedId ? 'project-a' : 'project-b' } }, undefined);
    const grant = issueMemoryAccessGrant({ rootId, runId, workspace, current: async () => current,
      resolve: async (binding) => ({ source: 'host', enforcement: 'enforced', projectIdentityVersion: 2, projectBindingRevision: 'fixture-binding', policy: {
        version: 1, revision: 0, principalId: `local:${rootId}`, dataRootId: rootId, ...binding, projectId: 'project-a',
        readMode: 'project', writeMode: 'disabled', selected: [], disabled: [], globalWriteGranted: false } }) });
    const result = await runner.run({ runId, text: 'catalog database', cwd: workspace, memoryAccessGrant: grant });
    expect(result.status).toBe('ok');
    expect(requests[0]).toContain('AUTHORIZED_ATOM');
    expect(requests[0]).not.toContain('PRIVATE_ATOM');
    expect(runner.infra.memoryService.getMemoryAccessContext(runId)).toBeUndefined();
    runId = 'propagation-run';
    const legacy = await runner.run({ runId, text: 'catalog database', cwd: workspace });
    expect(legacy.status).toBe('ok');
    expect(requests.at(-1)).toContain('PRIVATE_ATOM');
  } finally {
    await runner?.shutdown();
    if (previous === undefined) delete process.env.LITTLESHEEP_DATA_DIR; else process.env.LITTLESHEEP_DATA_DIR = previous;
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid fixture cleanup');
    await rm(root, { recursive: true, force: true });
  }
}, 90000);

it('refuses enforced startup without ownership evidence and ignores ordinary config/run mode claims', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ls-atom-mode-'));
  const previous = process.env.LITTLESHEEP_DATA_DIR;
  process.env.LITTLESHEEP_DATA_DIR = root;
  let runner: Awaited<ReturnType<typeof createRunner>> | undefined;
  let calls = 0;
  const llm: NonNullable<CreateRunnerOptions['llm']> = {
    async chat() {
      calls++;
      expect(runner!.infra.memoryService.getMemoryAccessContext('ordinary')?.enforcement).toBe('propagation-only');
      return { content: 'Synthetic reply.', finishReason: 'stop', toolCalls: [] };
    }, async chatStream(request) { return this.chat(request); },
    async embed(request) { return { model: request.model, embeddings: [[1, 0]], usage: { promptTokens: 0 } }; },
  };
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    (config.memory as unknown as Record<string, unknown>).memoryAccessEnforcement = 'enforced';
    runner = await createRunner({ config, branding: DEFAULT_BRANDING, model: 'test/model', llm, skillsDirs: [] });
    const rootId = memoryAccessRootId(root);
    const grant = issueMemoryAccessGrant({ rootId, runId: 'missing-store', workspace: root, current: async () => true,
      resolve: async (binding) => ({ source: 'host', enforcement: 'enforced', policy: {
        version: 1, revision: 0, principalId: `local:${rootId}`, dataRootId: rootId, ...binding,
        readMode: 'global', writeMode: 'disabled', selected: [], disabled: [], globalWriteGranted: false } }) });
    await expect(runner.run({ runId: 'missing-store', text: 'hello', cwd: root, memoryAccessGrant: grant })).rejects.toThrow('authorization unavailable');
    expect(calls).toBe(0);
    expect(runner.infra.memoryService.getMemoryAccessContext('missing-store')).toBeUndefined();
    const result = await runner.run({ runId: 'ordinary', text: 'hello', cwd: root, memoryAccessEnforcement: 'enforced' } as Parameters<typeof runner.run>[0]);
    expect(result.status).toBe('ok'); expect(calls).toBeGreaterThan(0);
  } finally {
    await runner?.shutdown();
    if (previous === undefined) delete process.env.LITTLESHEEP_DATA_DIR; else process.env.LITTLESHEEP_DATA_DIR = previous;
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid fixture cleanup');
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
