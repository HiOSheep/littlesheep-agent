import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asSessionId,
  type CompactionSummary,
  type RunAttachment,
  type RuntimeEventEnvelope,
} from '@littlesheep/types';
import { MemoryRepository, MemoryWriteService } from './memory-repository.js';
import {
  MemoryService,
  attachmentManifestResourceId,
  attachmentResourceId,
  runtimeEventLedgerResourceId,
} from './memory-service.js';
import { MemoryTree } from './memory-tree.js';

let dataDir: string;
let repository: MemoryRepository;
let tree: MemoryTree;
let service: MemoryService;
let summaries: Map<string, CompactionSummary>;
let runtimeEvents: Map<string, RuntimeEventEnvelope[]>;

function createService(targetTree: MemoryTree, targetRepository: MemoryRepository): MemoryService {
  const writer = new MemoryWriteService({
    repository: targetRepository,
    invalidate: (branch) => targetTree.invalidateBranch(branch),
  });
  return new MemoryService({
    tree: targetTree,
    repository: targetRepository,
    writer,
    dataDir,
    rootIndexMaxChars: 900,
    resolveSessionSummary: async (sessionId, summaryId) => {
      const summary = summaries.get(String(sessionId));
      return summary?.id === summaryId ? summary : undefined;
    },
    resolveRuntimeEvents: async (runId) => runtimeEvents.get(runId),
  });
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ls-memory-service-'));
  repository = new MemoryRepository({ dataDir });
  await repository.initialize();
  tree = new MemoryTree({ rootIndexMaxChars: 900, totalRunTokenBudget: 2_000, perBranchTokenBudget: 1_200 });
  summaries = new Map();
  runtimeEvents = new Map();
  service = createService(tree, repository);
});

afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

describe('MemoryService resource registry', () => {
  it('keeps T0 bounded and requires resource index navigation before loading a body', async () => {
    writeFileSync(join(dataDir, 'AGENTS.md'), 'AGENT-BODY-SHOULD-NOT-BE-PRELOADED\nAlways verify results.', 'utf8');
    writeFileSync(join(dataDir, 'SOUL.md'), 'Calm and factual.', 'utf8');
    writeFileSync(join(dataDir, 'USER.md'), 'User prefers Chinese.', 'utf8');
    writeFileSync(join(dataDir, 'PHILOSOPHY.md'), 'PHILOSOPHY-BODY-SHOULD-BE-INDEXED\nIdeas should become reliable outcomes.', 'utf8');
    writeFileSync(join(dataDir, 'TOOLS.md'), 'Use structured tools.', 'utf8');

    const bootstrap = await service.loadBootstrapFiles(dataDir);
    expect(bootstrap['AGENTS.md']).toContain('Always verify');
    expect(bootstrap['PHILOSOPHY.md']).toBeUndefined();
    const rootIndex = await service.rootIndex();
    expect(rootIndex.length).toBeLessThanOrEqual(900);
    expect(rootIndex).toContain('AGENTS.md');
    expect(rootIndex).not.toContain('AGENT-BODY-SHOULD-NOT-BE-PRELOADED');

    await service.beginRun({
      runId: 'run-resource',
      sessionId: asSessionId('session-resource'),
      query: 'What operating rules apply?',
      recentHistory: [],
      workspace: dataDir,
    });
    await expect(service.expand('run-resource', {
      branchId: 'resources',
      query: 'AGENTS',
    })).rejects.toThrow('has not been indexed');

    const index = await service.branchIndex('run-resource', 'resources');
    const agents = index.entries.find((entry) => entry.title === 'AGENTS.md');
    const philosophy = index.entries.find((entry) => entry.title === 'PHILOSOPHY.md');
    expect(agents).toBeDefined();
    expect(philosophy).toMatchObject({ metadata: { kind: 'philosophy', tier: 1 } });
    const expansion = await service.expand('run-resource', {
      branchId: 'resources',
      nodeId: agents!.id,
      tokenBudget: 500,
    });
    expect(expansion.fragments[0]?.content).toContain('AGENT-BODY-SHOULD-NOT-BE-PRELOADED');
    expect((await service.finishRun('run-resource'))?.records.map((record) => record.action)).toEqual([
      'root_index', 'expand', 'branch_index', 'expand',
    ]);
  });

  it('keeps workspace resources scoped to the workspace that registered them', async () => {
    const first = join(dataDir, 'project-a');
    const second = join(dataDir, 'project-b');
    mkdirSync(join(first, 'docs'), { recursive: true });
    mkdirSync(second, { recursive: true });
    writeFileSync(join(first, 'docs', 'architecture-principles.md'), '# Project A rules\nUse pnpm.', 'utf8');
    await service.syncWorkspaceDocuments(first);

    await service.beginRun({
      runId: 'run-a',
      sessionId: asSessionId('session-a'),
      query: 'project rules',
      recentHistory: [],
      workspace: first,
    });
    const firstIndex = await service.branchIndex('run-a', 'resources');
    expect(firstIndex.entries.some((entry) => entry.title === 'architecture-principles.md')).toBe(true);
    await service.finishRun('run-a');

    await service.beginRun({
      runId: 'run-b',
      sessionId: asSessionId('session-b'),
      query: 'project rules',
      recentHistory: [],
      workspace: second,
    });
    const secondIndex = await service.branchIndex('run-b', 'resources');
    expect(secondIndex.entries.some((entry) => entry.title === 'architecture-principles.md')).toBe(false);
    await service.finishRun('run-b');
  });

  it('registers one metadata-only workspace index and expands it without loading file bodies', async () => {
    const workspace = join(dataDir, 'indexed-project');
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'feature.ts'), 'PRIVATE-WORKSPACE-BODY', 'utf8');
    writeFileSync(join(workspace, 'README.md'), '# Public title', 'utf8');

    const sync = await service.syncWorkspaceResources(workspace, {
      boundaryKind: 'project',
      projectId: 'project-indexed',
    });
    expect(sync.snapshot.files.map((file) => file.relativePath)).toEqual(['README.md', 'src/feature.ts']);
    const resource = (await repository.listResources({ kind: 'workspace-index' }))[0];
    expect(resource).toMatchObject({
      scope: 'workspace',
      scopeKey: workspace,
      source: { kind: 'workspace-index', path: sync.indexPath },
      metadata: { fileCount: 2, scanStatus: 'complete' },
    });

    await service.beginRun({
      runId: 'run-workspace-index',
      sessionId: asSessionId('session-workspace-index'),
      query: 'modify src feature.ts',
      recentHistory: [],
      workspace,
    });
    const branch = await service.branchIndex('run-workspace-index', 'resources');
    const indexEntry = branch.entries.find((entry) => entry.id === resource!.id);
    expect(indexEntry).toBeDefined();
    const expansion = await service.expand('run-workspace-index', {
      branchId: 'resources',
      nodeId: resource!.id,
      tokenBudget: 600,
    });
    expect(expansion.fragments[0]?.content).toContain('src/feature.ts');
    expect(expansion.fragments[0]?.content).not.toContain('PRIVATE-WORKSPACE-BODY');
    await expect(service.manageResource(resource!.id, 'disable')).rejects.toThrow('运行时自动维护');
    await service.finishRun('run-workspace-index');
  });

  it('preserves the project workspace-index identity when the project folder is rebound', async () => {
    const previous = join(dataDir, 'project-before');
    const moved = join(dataDir, 'project-after');
    mkdirSync(previous, { recursive: true });
    writeFileSync(join(previous, 'task.ts'), 'task', 'utf8');
    await service.syncWorkspaceResources(previous, {
      boundaryKind: 'project',
      projectId: 'project-stable',
    });
    const before = (await repository.listResources({ kind: 'workspace-index' }))[0]!;

    renameSync(previous, moved);
    await service.rebindProjectPath(
      { id: 'project-stable', name: 'Before', path: previous },
      { id: 'project-stable', name: 'After', path: moved },
    );

    const after = (await repository.listResources({ kind: 'workspace-index' }))[0]!;
    expect(after.id).toBe(before.id);
    expect(after.scopeKey).toBe(moved);
    expect(after.source.path).toBe(before.source.path);
    const snapshot = await service.syncWorkspaceResources(moved, {
      boundaryKind: 'project',
      projectId: 'project-stable',
    });
    expect(snapshot.snapshot.files.map((file) => file.relativePath)).toContain('task.ts');
  });

  it('keeps plugin Skill identity stable while the plugin owner controls lifecycle changes', async () => {
    const firstRoot = join(dataDir, 'plugin-v1', 'skills');
    const firstSkillDir = join(firstRoot, 'planner');
    mkdirSync(firstSkillDir, { recursive: true });
    writeFileSync(
      join(firstSkillDir, 'SKILL.md'),
      '---\nname: planner\ndescription: Plan work.\n---\nPlan carefully.\n',
      'utf8',
    );
    const activeSource = {
      id: 'plugin:test.planner',
      kind: 'plugin' as const,
      ownerId: 'test.planner',
      dir: firstRoot,
      enabled: true,
    };
    const activeSkill = {
      name: 'planner',
      description: 'Plan work.',
      dir: firstSkillDir,
      source: activeSource,
      availability: 'active' as const,
    };

    await service.syncSkillResources([activeSkill], [activeSource], { ownerKinds: ['plugin'] });
    const initial = (await repository.listResources({ kind: 'skill' }))[0]!;
    expect(initial).toMatchObject({
      status: 'active',
      registryGroup: 'skills:plugin:test.planner',
      owner: { kind: 'plugin', id: 'test.planner', controller: 'plugin-host' },
      metadata: { skillName: 'planner', skillAvailability: 'active' },
    });

    const disabledSource = { ...activeSource, enabled: false };
    await service.syncSkillResources([{
      ...activeSkill,
      source: disabledSource,
      availability: 'disabled',
    }], [disabledSource], { ownerKinds: ['plugin'] });
    expect(await repository.getResource(initial.id)).toMatchObject({ status: 'disabled' });

    await service.syncSkillResources([activeSkill], [activeSource], { ownerKinds: ['plugin'] });
    expect(await repository.getResource(initial.id)).toMatchObject({ status: 'active' });

    const secondRoot = join(dataDir, 'plugin-v2', 'skills');
    const secondSkillDir = join(secondRoot, 'planner');
    mkdirSync(secondRoot, { recursive: true });
    renameSync(firstSkillDir, secondSkillDir);
    const movedSource = { ...activeSource, dir: secondRoot };
    await service.syncSkillResources([{
      ...activeSkill,
      dir: secondSkillDir,
      source: movedSource,
    }], [movedSource], { ownerKinds: ['plugin'] });
    expect(await repository.getResource(initial.id)).toMatchObject({
      id: initial.id,
      status: 'active',
      source: { path: join(secondSkillDir, 'SKILL.md') },
    });
    expect(await repository.listResourceManagementAudit(initial.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'rebind', reason: expect.stringContaining('随其所有者迁移') }),
      expect.objectContaining({ action: 'restore', reason: expect.stringContaining('插件“test.planner”') }),
      expect.objectContaining({ action: 'disable', reason: expect.stringContaining('插件“test.planner”') }),
    ]));
    await expect(service.manageResource(initial.id, 'disable')).rejects.toThrow('插件宿主管理');

    await service.syncSkillResources([], [], { ownerKinds: ['plugin'] });
    expect(await repository.getResource(initial.id)).toMatchObject({ status: 'missing' });
  });

  it('marks undiscovered ownerless v2 Skill registrations missing during owner migration', async () => {
    const legacyPath = join(dataDir, 'removed-skill', 'SKILL.md');
    await repository.replaceResourceGroup('skills', [{
      version: 1,
      id: 'legacy-skill',
      kind: 'skill',
      title: 'removed-skill',
      description: 'Legacy ownerless skill registration.',
      tier: 2,
      scope: 'global',
      authority: 'authoritative',
      privacy: 'private',
      source: { kind: 'file', path: legacyPath },
      indexKeys: ['removed-skill'],
      status: 'active',
      registryGroup: 'skills',
      registeredAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    }]);

    await service.syncSkillResources([], [{
      id: 'user',
      kind: 'user',
      dir: join(dataDir, 'skills'),
      enabled: true,
    }], { ownerKinds: ['user'] });

    expect(await repository.getResource('legacy-skill')).toMatchObject({ status: 'missing' });
  });

  it('reconciles, relocates, disables and safely removes workspace document registrations', async () => {
    const workspace = join(dataDir, 'managed-project');
    const docs = join(workspace, 'docs');
    const originalPath = join(docs, 'project-guidelines.md');
    const movedPath = join(docs, 'architecture-principles.md');
    mkdirSync(docs, { recursive: true });
    writeFileSync(originalPath, '# Project rules\nUse verified commands.', 'utf8');
    await service.syncWorkspaceDocuments(workspace);
    const original = (await service.listResources({ scope: 'workspace', scopeKey: workspace }))[0]!;

    await service.manageResource(original.id, 'disable');
    await service.syncWorkspaceDocuments(workspace);
    expect(await repository.getResource(original.id)).toMatchObject({ status: 'disabled' });
    await expect(service.manageResource(original.id, 'restore')).resolves.toMatchObject({
      audit: { reason: '用户恢复了已登记的记忆资源。' },
    });
    expect(await repository.getResource(original.id)).toMatchObject({ status: 'active' });

    renameSync(originalPath, movedPath);
    await service.syncWorkspaceDocuments(workspace);
    expect(await repository.getResource(original.id)).toMatchObject({ status: 'missing' });
    await expect(service.rebindResourceSource(original.id, movedPath)).resolves.toMatchObject({
      changed: true,
      resource: { id: original.id, status: 'active', source: { path: movedPath } },
    });
    await service.syncWorkspaceDocuments(workspace);
    const afterSync = await service.listResources({ scope: 'workspace', scopeKey: workspace });
    expect(afterSync).toHaveLength(1);
    expect(afterSync[0]).toMatchObject({ id: original.id, source: { path: movedPath }, status: 'active' });

    const outsidePath = join(dataDir, 'outside-guidelines.md');
    writeFileSync(outsidePath, '# Outside', 'utf8');
    await expect(service.rebindResourceSource(original.id, outsidePath)).rejects.toThrow('已授权工作区');
    await expect(service.manageResource(original.id, 'remove')).rejects.toThrow('请先停用活动资源');
    await service.manageResource(original.id, 'disable');
    await service.manageResource(original.id, 'remove');
    expect(await repository.getResource(original.id)).toBeUndefined();
  });

  it('registers only summary metadata and resolves the exact session summary after restart', async () => {
    const sessionId = asSessionId('session-summary');
    const summary: CompactionSummary = {
      version: 1,
      id: 'summary-v1',
      collapsedCount: 12,
      summary: 'PRIVATE-SUMMARY-BODY: preserve the current project decision.',
      compactedAt: '2026-07-13T10:00:00.000Z',
      sourceStartMessageId: 'message-1',
      sourceEndMessageId: 'message-12',
      sourceStartAt: '2026-07-13T08:00:00.000Z',
      sourceEndAt: '2026-07-13T09:59:00.000Z',
      model: 'test/model',
    };
    summaries.set(String(sessionId), summary);
    await service.registerSessionSummary(sessionId, summary);

    const persisted = JSON.stringify(await repository.snapshot());
    expect(persisted).not.toContain('PRIVATE-SUMMARY-BODY');
    expect(await repository.getResource(summary.id)).toMatchObject({
      id: summary.id,
      kind: 'summary-memory',
      scope: 'session',
      scopeKey: String(sessionId),
      source: { kind: 'session-summary', id: summary.id },
    });

    const reopenedRepository = new MemoryRepository({ dataDir });
    await reopenedRepository.initialize();
    const reopenedTree = new MemoryTree({ rootIndexMaxChars: 900, totalRunTokenBudget: 2_000, perBranchTokenBudget: 1_200 });
    const reopenedService = createService(reopenedTree, reopenedRepository);
    await reopenedService.beginRun({
      runId: 'run-summary-restart',
      sessionId,
      query: 'What project decision was preserved?',
      recentHistory: [],
      workspace: dataDir,
    });
    await expect(reopenedService.expand('run-summary-restart', {
      branchId: 'resources',
      nodeId: summary.id,
    })).rejects.toThrow('has not been indexed');
    const index = await reopenedService.branchIndex('run-summary-restart', 'resources');
    expect(index.entries.map((entry) => entry.id)).toContain(summary.id);
    const expansion = await reopenedService.expand('run-summary-restart', {
      branchId: 'resources',
      nodeId: summary.id,
      tokenBudget: 500,
    });
    expect(expansion.fragments[0]?.content).toContain('PRIVATE-SUMMARY-BODY');
    await reopenedService.finishRun('run-summary-restart');

    await reopenedService.beginRun({
      runId: 'run-other-session',
      sessionId: asSessionId('session-other'),
      query: 'summary',
      recentHistory: [],
      workspace: dataDir,
    });
    const otherIndex = await reopenedService.branchIndex('run-other-session', 'resources');
    expect(otherIndex.entries.map((entry) => entry.id)).not.toContain(summary.id);
    await reopenedService.finishRun('run-other-session');
  });

  it('keeps attachment bodies ephemeral and replaces the prior run registry for a session', async () => {
    const sessionId = asSessionId('session-attachments');
    const attachment: RunAttachment = {
      id: 'notes-file',
      path: join(dataDir, 'notes.md'),
      name: 'notes.md',
      kind: 'document',
      mimeType: 'text/markdown',
      size: 321,
      dataUrl: 'data:text/plain;base64,PRIVATE-DATA-URL',
      extractedText: 'PRIVATE-ATTACHMENT-BODY',
      ownership: 'external',
      contentState: 'loaded',
    };
    await service.registerRunResources({
      runId: 'run-attachments-1',
      sessionId,
      workspace: dataDir,
      attachments: [attachment],
    });

    const manifestId = attachmentManifestResourceId('run-attachments-1');
    const resourceId = attachmentResourceId('run-attachments-1', 'notes-file');
    const persisted = JSON.stringify(await repository.snapshot());
    expect(persisted).not.toContain('PRIVATE-DATA-URL');
    expect(persisted).not.toContain('PRIVATE-ATTACHMENT-BODY');
    expect(await repository.getResource(manifestId)).toMatchObject({ scope: 'run', scopeKey: 'run-attachments-1' });
    expect(await repository.getResource(resourceId)).toMatchObject({
      kind: 'attachment',
      source: { kind: 'attachment', id: 'notes-file' },
    });

    await service.beginRun({
      runId: 'run-attachments-1',
      sessionId,
      query: 'inspect notes',
      recentHistory: [],
      workspace: dataDir,
    });
    await service.branchIndex('run-attachments-1', 'resources');
    const manifest = await service.expand('run-attachments-1', {
      branchId: 'resources',
      nodeId: manifestId,
      tokenBudget: 500,
    });
    expect(manifest.fragments[0]?.content).toContain('notes.md');
    expect(manifest.fragments[0]?.content).not.toContain('PRIVATE-ATTACHMENT-BODY');
    const attachmentExpansion = await service.expand('run-attachments-1', {
      branchId: 'resources',
      nodeId: resourceId,
      tokenBudget: 500,
    });
    expect(attachmentExpansion.fragments[0]?.content).toContain('PRIVATE-ATTACHMENT-BODY');
    await service.finishRun('run-attachments-1');
    expect(await repository.listResources({ scope: 'run', scopeKey: 'run-attachments-1' }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: manifestId, status: 'missing' }),
        expect.objectContaining({ id: resourceId, status: 'missing' }),
      ]));

    await service.beginRun({
      runId: 'run-attachments-1',
      sessionId,
      query: 'reused id must not retain body',
      recentHistory: [],
      workspace: dataDir,
    });
    await service.branchIndex('run-attachments-1', 'resources');
    const afterFinish = await service.expand('run-attachments-1', {
      branchId: 'resources',
      nodeId: resourceId,
      tokenBudget: 500,
    });
    expect(afterFinish.fragments).toEqual([]);
    await service.finishRun('run-attachments-1');

    await service.registerRunResources({
      runId: 'run-attachments-2',
      sessionId,
      workspace: dataDir,
      attachments: [],
    });
    expect(await repository.listResources({ registryGroup: `session-attachments:${sessionId}` })).toEqual([]);
  });

  it('registers a run-scoped runtime event ledger without copying event payload values', async () => {
    const sessionId = asSessionId('session-events');
    const runId = 'run-events-1';
    const events: RuntimeEventEnvelope[] = [{
      version: 1,
      id: 'event-1',
      runId,
      sessionId,
      sequence: 1,
      type: 'user_message',
      source: 'app',
      status: 'queued',
      receivedAt: '2026-07-13T11:00:00.000Z',
      payload: { text: 'PRIVATE-EVENT-PAYLOAD', apiKey: 'PRIVATE-EVENT-KEY' },
    }, {
      version: 1,
      id: 'event-2',
      runId,
      sessionId,
      sequence: 2,
      type: 'workspace_file_saved',
      source: 'workspace',
      status: 'applied',
      receivedAt: '2026-07-13T11:00:01.000Z',
      appliedAt: '2026-07-13T11:00:02.000Z',
      payload: { path: 'D:/private/project/secret.txt' },
      decisionReason: 'PRIVATE-DECISION-DETAIL',
    }];
    runtimeEvents.set(runId, events);
    await service.registerRuntimeEvents(runId, sessionId, events);

    const resourceId = runtimeEventLedgerResourceId(runId);
    const serialized = JSON.stringify(await repository.snapshot());
    expect(serialized).not.toContain('PRIVATE-EVENT-PAYLOAD');
    expect(serialized).not.toContain('PRIVATE-EVENT-KEY');
    expect(serialized).not.toContain('PRIVATE-DECISION-DETAIL');
    expect(await repository.getResource(resourceId)).toMatchObject({
      kind: 'runtime-event-ledger',
      scope: 'run',
      scopeKey: runId,
      source: { kind: 'runtime-event', id: resourceId },
      metadata: { eventCount: 2, firstSequence: 1, latestSequence: 2 },
    });

    await service.beginRun({
      runId,
      sessionId,
      query: 'What changed while this run was active?',
      recentHistory: [],
      workspace: dataDir,
    });
    await service.branchIndex(runId, 'resources');
    const expansion = await service.expand(runId, {
      branchId: 'resources',
      nodeId: resourceId,
      tokenBudget: 500,
    });
    expect(expansion.fragments[0]?.content).toContain('#1 user_message');
    expect(expansion.fragments[0]?.content).toContain('#2 workspace_file_saved');
    expect(expansion.fragments[0]?.content).toContain('payload keys=text, apiKey');
    expect(expansion.fragments[0]?.content).not.toContain('PRIVATE-EVENT-PAYLOAD');
    expect(expansion.fragments[0]?.content).not.toContain('PRIVATE-EVENT-KEY');
    expect(expansion.fragments[0]?.content).not.toContain('PRIVATE-DECISION-DETAIL');
    await service.finishRun(runId);

    await expect(service.registerRuntimeEvents(runId, sessionId, [{
      ...events[0]!,
      id: 'wrong-session-event',
      sessionId: asSessionId('different-session'),
    }])).rejects.toThrow('does not belong to run');

    await service.registerRuntimeEvents('run-events-2', sessionId, []);
    expect(await repository.getResource(resourceId)).toBeUndefined();
  });
});
