import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { createRunner, type CreateRunnerOptions } from '@littlesheep/runner';
import { createMemoryV3ExperimentMarker, issueMemoryAccessGrant, memoryAccessRootId,
  type MemoryAccessSnapshot, type MemoryAccessGrant } from '@littlesheep/memory-tree';
import { ProjectIndex } from './project-index.js';
import { SessionIndex } from './session-index.js';
import { createHostMemoryAccessGrant } from './memory-access-host.js';
type LlmClient = NonNullable<CreateRunnerOptions['llm']>;
type ChatRequest = Parameters<LlmClient['chat']>[0];

it.each(['v2', 'v3'] as const)('Host → real Runner → MemoryService propagation and compatibility (%s)', async (backend) => {
  const root = await mkdtemp(join(tmpdir(), 'ls-access-chain-'));
  const previous = process.env.LITTLESHEEP_DATA_DIR;
  process.env.LITTLESHEEP_DATA_DIR = root;
  let runner: Awaited<ReturnType<typeof createRunner>> | undefined;
  let activeRun = 'host-run';
  const snapshots: MemoryAccessSnapshot[] = [], requests: ChatRequest[] = [];
  const llm: LlmClient = {
    async chat(request) { requests.push(request); snapshots.push(runner!.infra.memoryService.getMemoryAccessContext(activeRun)!);
      return { content: 'Fixture reply.', finishReason: 'stop', toolCalls: [] }; },
    async chatStream(request) { return this.chat(request); },
    async embed(request) { return { model: request.model, embeddings: [[0.1, 0.2]], usage: { promptTokens: 0 } }; },
  };
  try {
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    if (backend === 'v3') await createMemoryV3ExperimentMarker(root);
    const projects = new ProjectIndex({ dataDir: root }), sessions = new SessionIndex({ dataDir: root });
    const project = await projects.ensure(workspace);
    const config = structuredClone(DEFAULT_CONFIG); config.memory.repositoryBackend = backend;
    runner = await createRunner({ config, branding: DEFAULT_BRANDING, model: 'test/model', llm, skillsDirs: [] });
    const grant = await createHostMemoryAccessGrant({ dataDir: root, runId: activeRun, workspace,
      ownership: { scope: 'project', projectId: project.id }, sessionIndex: sessions, projectIndex: projects });
    const first = await runner.run({ runId: activeRun, text: 'hello', cwd: workspace, memoryAccessGrant: grant });
    expect(first.status).toBe('ok');
    expect(snapshots[0]).toMatchObject({ source: 'host', enforcement: 'propagation-only', policy: { projectId: project.id, sessionId: String(first.sessionId), runId: activeRun } });
    expect(runner.infra.memoryService.getMemoryAccessContext(activeRun)).toBeUndefined();
    expect(runner.inspectContext?.(String(first.sessionId)).requests.length).toBeGreaterThan(0);
    const wrongWorkspaceContext = await runner.infra.memoryService.createRunAccessContext({
      runId: 'workspace-check', sessionId: String(first.sessionId), workspace,
    });
    await expect(runner.infra.memoryService.beginRun({ runId: 'workspace-check', sessionId: first.sessionId,
      workspace: join(root, 'other'), query: 'fixture', recentHistory: [],
    }, wrongWorkspaceContext)).rejects.toThrow('Untrusted');
    expect(runner.infra.memoryService.getMemoryAccessContext('workspace-check')).toBeUndefined();
    const log = JSON.stringify(await runner.replay(first.runId));
    expect(log).not.toContain('projectBindingRevision');
    expect(log).not.toContain('memoryAccessGrant');
    expect(log).not.toContain('local:root:');
    activeRun = 'direct-run';
    const next = await runner.run({ runId: activeRun, sessionId: first.sessionId, text: 'continue', cwd: workspace,
      workspaceContext: { boundaryKind: 'project', projectId: 'self-declared' } });
    expect(next.status).toBe('ok');
    expect(snapshots.at(-1)).toMatchObject({ source: 'standalone-adapter', policy: { readMode: 'none', writeMode: 'disabled' } });
    expect(snapshots.at(-1)?.policy.projectId).toBeUndefined();
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('Fixture reply.');
    const before = requests.length;
    await expect(runner.run({ runId: 'fake-run', sessionId: first.sessionId, text: 'forged', cwd: workspace,
      memoryAccessGrant: JSON.parse(JSON.stringify(grant)) as MemoryAccessGrant })).rejects.toThrow('Untrusted');
    expect(requests).toHaveLength(before);
    let checks = 0;
    const stale = issueMemoryAccessGrant({ rootId: memoryAccessRootId(root), runId: 'stale-run', sessionId: String(first.sessionId), workspace,
      current: async () => ++checks <= 2, resolve: async () => ({ ...snapshots[0]!, policy: { ...snapshots[0]!.policy, runId: 'stale-run' } }) });
    await expect(runner.run({ runId: 'stale-run', sessionId: first.sessionId, text: 'stale', cwd: workspace,
      memoryAccessGrant: stale })).rejects.toThrow('Stale memory access context');
    expect(requests).toHaveLength(before);
    expect(await runner.infra.sessionManager.read(first.sessionId)).not.toEqual([]);
    activeRun = 'degraded-run';
    vi.spyOn(runner.infra.memoryService, 'rootIndex').mockRejectedValueOnce(new Error('fixture operational index failure'));
    const degraded = await runner.run({ runId: activeRun, sessionId: first.sessionId, text: 'continue safely', cwd: workspace });
    expect(degraded.status).toBe('ok');
    expect(snapshots.at(-1)).toMatchObject({ enforcement: 'propagation-only', source: 'standalone-adapter' });
    expect(runner.infra.memoryService.getMemoryAccessContext(activeRun)).toBeUndefined();
  } finally {
    await runner?.shutdown();
    if (previous === undefined) delete process.env.LITTLESHEEP_DATA_DIR; else process.env.LITTLESHEEP_DATA_DIR = previous;
    const target = resolve(root), rel = relative(resolve(tmpdir()), target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid fixture cleanup');
    await rm(target, { recursive: true, force: true });
  }
}, 60000);
