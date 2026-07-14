import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asSessionId } from '@littlesheep/types';
import { MemoryRepository, MemoryWriteService } from './memory-repository.js';
import { MemoryService } from './memory-service.js';
import { MemoryTree } from './memory-tree.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ls-resource-scaling-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

async function createRuntime(): Promise<{
  repository: MemoryRepository;
  tree: MemoryTree;
  service: MemoryService;
}> {
  const repository = new MemoryRepository({ dataDir });
  await repository.initialize();
  const tree = new MemoryTree({
    rootIndexMaxChars: 900,
    totalRunTokenBudget: 6_000,
    perBranchTokenBudget: 3_000,
  });
  const writer = new MemoryWriteService({
    repository,
    invalidate: (branch) => tree.invalidateBranch(branch),
  });
  const service = new MemoryService({
    tree,
    repository,
    writer,
    dataDir,
    rootIndexMaxChars: 900,
  });
  return { repository, tree, service };
}

describe('resource registry scaling and recovery', () => {
  it('keeps 256 Skills bounded, queryable beyond the first index page, and restart-safe', async () => {
    const { repository, service } = await createRuntime();
    const sources = [];
    const skills = [];
    for (let sourceIndex = 0; sourceIndex < 8; sourceIndex += 1) {
      const source = {
        id: `external:catalog-${sourceIndex}`,
        kind: 'external' as const,
        ownerId: `catalog-${sourceIndex}`,
        dir: join(dataDir, 'skills', `catalog-${sourceIndex}`),
        enabled: true,
      };
      sources.push(source);
      for (let skillIndex = 0; skillIndex < 32; skillIndex += 1) {
        const number = sourceIndex * 32 + skillIndex;
        const name = `scale-skill-${number.toString().padStart(3, '0')}`;
        const dir = join(source.dir, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'SKILL.md'),
          `---\nname: ${name}\ndescription: Scaling skill ${number}.\n---\nBODY-${number}\n`,
          'utf8',
        );
        skills.push({
          name,
          description: `Scaling skill ${number}.`,
          whenToUse: `scale task ${number}`,
          dir,
          source,
          availability: 'active' as const,
        });
      }
    }

    const syncStartedAt = Date.now();
    await service.syncSkillResources(skills, sources, { ownerKinds: ['external'] });
    expect(Date.now() - syncStartedAt).toBeLessThan(8_000);

    const registered = await repository.listResources({ kind: 'skill' });
    expect(registered).toHaveLength(256);
    expect(new Set(registered.map((resource) => resource.id)).size).toBe(256);
    expect((await service.rootIndex()).length).toBeLessThanOrEqual(900);

    await service.beginRun({
      runId: 'scale-skills-run',
      sessionId: asSessionId('scale-skills-session'),
      query: 'scale-skill-255',
      recentHistory: [],
      workspace: dataDir,
    });
    const index = await service.branchIndex('scale-skills-run', 'resources');
    expect(index.truncated).toBe(true);
    expect(index.entries.length).toBeLessThanOrEqual(100);
    const result = await service.expand('scale-skills-run', {
      branchId: 'resources',
      query: 'scale-skill-255',
      limit: 2,
      tokenBudget: 500,
    });
    expect(result.fragments).toEqual([
      expect.objectContaining({ content: expect.stringContaining('BODY-255') }),
    ]);
    await service.finishRun('scale-skills-run');

    const restarted = await createRuntime();
    expect(await restarted.repository.listResources({ kind: 'skill' })).toHaveLength(256);
    expect((await restarted.service.rootIndex()).length).toBeLessThanOrEqual(900);
  }, 15_000);

  it('isolates deep documents across projects and preserves identity through move and restart', async () => {
    const { repository, service } = await createRuntime();
    const projects: string[] = [];
    const deepDocuments: string[] = [];
    const syncStartedAt = Date.now();
    for (let index = 0; index < 12; index += 1) {
      const project = join(dataDir, 'projects', `project-${index}`);
      const deepDir = join(project, 'docs', 'area', `team-${index}`, 'decisions', 'current');
      const deepDocument = join(deepDir, `project-${index}-architecture.md`);
      mkdirSync(deepDir, { recursive: true });
      writeFileSync(join(project, 'README.md'), `# Project ${index}\n`, 'utf8');
      writeFileSync(deepDocument, `# Architecture ${index}\nPROJECT-${index}-ONLY\n`, 'utf8');
      const ignoredDir = join(project, 'docs', 'node_modules', 'ignored');
      mkdirSync(ignoredDir, { recursive: true });
      writeFileSync(join(ignoredDir, `ignored-${index}-architecture.md`), 'SHOULD-NOT-REGISTER', 'utf8');
      projects.push(project);
      deepDocuments.push(deepDocument);
      await service.syncWorkspaceDocuments(project);
    }
    expect(Date.now() - syncStartedAt).toBeLessThan(8_000);

    const activeWorkspaceResources = await repository.listResources({ status: 'active' });
    expect(activeWorkspaceResources.filter((resource) => resource.scope === 'workspace')).toHaveLength(24);
    expect(activeWorkspaceResources.some((resource) => resource.title.includes('ignored-'))).toBe(false);

    await service.beginRun({
      runId: 'project-eleven-run',
      sessionId: asSessionId('project-eleven-session'),
      query: 'project architecture',
      recentHistory: [],
      workspace: projects[11]!,
    });
    const projectElevenIndex = await service.branchIndex('project-eleven-run', 'resources');
    expect(projectElevenIndex.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: expect.stringContaining('project-11-architecture.md') }),
    ]));
    expect(projectElevenIndex.entries.some((entry) => entry.title.includes('project-0-architecture'))).toBe(false);
    await service.finishRun('project-eleven-run');

    const original = (await repository.listResources({ scope: 'workspace', scopeKey: projects[11] }))
      .find((resource) => resource.source.path === deepDocuments[11])!;
    const movedDir = join(projects[11]!, 'docs', 'area', 'moved', 'decisions');
    const movedPath = join(movedDir, 'project-11-architecture.md');
    mkdirSync(movedDir, { recursive: true });
    renameSync(deepDocuments[11]!, movedPath);
    await service.syncWorkspaceDocuments(projects[11]!);
    expect(await repository.getResource(original.id)).toMatchObject({ status: 'missing' });

    await service.rebindResourceSource(original.id, movedPath);
    const afterMove = await repository.listResources({ scope: 'workspace', scopeKey: projects[11] });
    expect(afterMove.filter((resource) => resource.status === 'active')).toHaveLength(2);
    expect(afterMove).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: original.id,
        status: 'active',
        source: expect.objectContaining({ path: movedPath }),
      }),
    ]));

    const restarted = await createRuntime();
    expect(await restarted.repository.getResource(original.id)).toMatchObject({
      status: 'active',
      source: { path: movedPath },
    });
    await restarted.service.beginRun({
      runId: 'project-zero-run',
      sessionId: asSessionId('project-zero-session'),
      query: 'project architecture',
      recentHistory: [],
      workspace: projects[0]!,
    });
    const projectZeroIndex = await restarted.service.branchIndex('project-zero-run', 'resources');
    expect(projectZeroIndex.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: expect.stringContaining('project-0-architecture.md') }),
    ]));
    expect(projectZeroIndex.entries.some((entry) => entry.title.includes('project-11-architecture'))).toBe(false);
    await restarted.service.finishRun('project-zero-run');
  }, 15_000);
});
