import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InjectionTier, type MemoryWriteIntent } from './types.js';
import { MemoryRepository } from './memory-repository.js';
import {
  ProjectMemoryProjectionService,
  projectProjectionResourceId,
  type ProjectMemoryPrivateProjection,
  type ProjectMemoryTarget,
} from './project-memory-projection.js';

let dataDir: string;
let projectDir: string;
let repository: MemoryRepository;
let service: ProjectMemoryProjectionService;
let project: ProjectMemoryTarget;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ls-project-memory-projection-'));
  projectDir = join(dataDir, 'project-a');
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\n', 'utf8');
  repository = new MemoryRepository({ dataDir });
  await repository.initialize();
  service = new ProjectMemoryProjectionService({ dataDir, repository });
  project = { id: 'project-a-stable', name: 'Project A', path: projectDir };
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function projectIntent(overrides: Partial<MemoryWriteIntent> = {}): MemoryWriteIntent {
  return {
    branch: 'project',
    parentNodeId: 'project:root',
    scope: 'workspace',
    scopeKey: projectDir,
    tier: InjectionTier.T2_RELEVANT,
    summary: 'Use the workspace build command',
    content: `Run pnpm build from ${projectDir} before release.`,
    retrievalKeys: ['build', 'pnpm', projectDir],
    sourceRunId: 'run-project-memory',
    sourceStage: 'evolve',
    sourceRefs: ['C:/Users/private/review-notes.txt'],
    importance: 0.8,
    confidence: 0.9,
    reason: 'Verified from the project scripts and a completed build.',
    ...overrides,
  };
}

async function seedProjectionCases(): Promise<void> {
  await repository.write(projectIntent({
    tier: InjectionTier.T1_ESSENTIAL,
    summary: 'Use pnpm for verified builds',
    content: `The verified build command is pnpm build in ${projectDir}.`,
    retrievalKeys: ['verified build', 'pnpm'],
  }));
  await repository.write(projectIntent({
    id: 'low-confidence',
    summary: 'Possible draft naming convention',
    content: 'A draft suggests prefixing experimental files with trial-.',
    retrievalKeys: ['draft naming'],
    confidence: 0.65,
  }));
  await repository.write(projectIntent({
    id: 't3-detail',
    tier: InjectionTier.T3_DETAIL,
    summary: 'Low frequency implementation detail',
    content: 'One temporary diagnostic used port 45678.',
    retrievalKeys: ['temporary diagnostic'],
  }));
  await repository.write(projectIntent({
    id: 'secret-memory',
    summary: 'Provider credential used during a test',
    content: 'api_key=super-secret-project-value',
    retrievalKeys: ['provider credential'],
  }));
}

describe('ProjectMemoryProjectionService', () => {
  it('creates an opt-in private projection without changing the authoritative memory', async () => {
    await seedProjectionCases();
    const before = await repository.listNodes('project');
    const state = await service.enable(project);

    expect(state).toMatchObject({
      enabled: true,
      status: 'ready',
      projectionExists: true,
      safeToRemove: true,
      gitRepository: true,
      gitIgnored: false,
      gitIgnorePattern: '/.littlesheep/',
      entryCount: 2,
      omittedEntryCount: 2,
    });
    expect(readFileSync(join(projectDir, '.gitignore'), 'utf8')).toBe('node_modules/\n');
    const projectionPath = service.projectionPath(project);
    const raw = readFileSync(projectionPath, 'utf8');
    const projection = JSON.parse(raw) as ProjectMemoryPrivateProjection;
    expect(projection).toMatchObject({
      version: 1,
      kind: 'littlesheep-project-memory-private',
      authority: 'derived-projection',
      privacy: 'project-private',
      project: { id: project.id, name: project.name },
      omittedEntryCount: 2,
    });
    expect(projection.entries).toHaveLength(2);
    expect(projection.entries.map((entry) => entry.summary)).toEqual(expect.arrayContaining([
      'Use pnpm for verified builds',
      'Possible draft naming convention',
    ]));
    expect(raw).toContain('<project-root>');
    expect(raw).not.toContain(projectDir);
    expect(raw).not.toContain('super-secret-project-value');
    expect(raw).not.toContain('sourceRunIds');
    expect(raw).not.toContain('review-notes.txt');
    expect(raw).not.toContain('Verified from the project scripts');

    expect(await repository.getResource(projectProjectionResourceId(project.id))).toMatchObject({
      kind: 'project-memory-projection',
      scope: 'project',
      scopeKey: projectDir,
      privacy: 'project-private',
      authority: 'derived',
      source: { kind: 'file', path: projectionPath },
    });
    expect(await repository.listNodes('project')).toEqual(before);
  });

  it('rebinds an enabled projection and its resource after the project directory moves', async () => {
    await repository.write(projectIntent());
    await service.enable(project);
    const previous = { ...project };
    const movedPath = join(dataDir, 'project-moved');
    renameSync(projectDir, movedPath);
    await repository.rebindProjectPath(projectDir, movedPath);
    project = { ...project, name: 'Project Moved', path: movedPath };

    const state = await service.rebind(previous, project);

    expect(state).toMatchObject({
      projectId: project.id,
      projectName: 'Project Moved',
      projectPath: movedPath,
      status: 'ready',
      projectionExists: true,
      safeToRemove: true,
    });
    const projection = JSON.parse(readFileSync(service.projectionPath(project), 'utf8')) as ProjectMemoryPrivateProjection;
    expect(projection.project).toEqual({ id: project.id, name: 'Project Moved' });
    expect(await repository.getResource(projectProjectionResourceId(project.id))).toMatchObject({
      scopeKey: movedPath,
      source: { path: service.projectionPath(project) },
      metadata: { projectId: project.id, projectionStatus: 'ready' },
    });
    const registry = JSON.parse(readFileSync(service.registryPath, 'utf8')) as {
      projects: Record<string, { projectPath: string }>;
    };
    expect(registry.projects[project.id]?.projectPath).toBe(movedPath);
  });

  it('reports stale and conflict states instead of silently overwriting changes', async () => {
    await seedProjectionCases();
    await service.enable(project);
    await repository.write(projectIntent({
      id: 'new-memory',
      summary: 'Use the release verification script',
      content: 'Run pnpm verify before creating a release package.',
      retrievalKeys: ['release verification'],
    }));
    expect(await service.getState(project)).toMatchObject({ status: 'stale', entryCount: 2 });
    expect(await service.sync(project)).toMatchObject({ status: 'ready', entryCount: 3 });

    const projectionPath = service.projectionPath(project);
    writeFileSync(projectionPath, '{"manual":true}', 'utf8');
    const conflict = await service.sync(project);
    expect(conflict.status).toBe('conflict');
    expect(conflict.safeToRemove).toBe(false);
    expect(conflict.conflictReason).toContain('changed outside LittleSheep');
    expect(readFileSync(projectionPath, 'utf8')).toBe('{"manual":true}');
    expect(await repository.getResource(projectProjectionResourceId(project.id))).toMatchObject({
      status: 'conflict',
      metadata: { projectionStatus: 'conflict' },
    });

    const recovered = await service.sync(project, { force: true });
    expect(recovered.status).toBe('ready');
    expect(readFileSync(projectionPath, 'utf8')).toContain('littlesheep-project-memory-private');
    expect(await repository.getResource(projectProjectionResourceId(project.id))).toMatchObject({
      status: 'active',
      metadata: { projectionStatus: 'ready' },
    });
  });

  it('reconciles a missing projection with the resource registry', async () => {
    await repository.write(projectIntent());
    await service.enable(project);
    rmSync(service.projectionPath(project), { force: true });

    await expect(service.getState(project)).resolves.toMatchObject({ status: 'missing' });
    expect(await repository.getResource(projectProjectionResourceId(project.id))).toMatchObject({
      status: 'missing',
      metadata: { projectionStatus: 'missing' },
    });
    await expect(service.sync(project)).resolves.toMatchObject({ status: 'ready' });
    expect(await repository.getResource(projectProjectionResourceId(project.id))).toMatchObject({ status: 'active' });
  });

  it('does not adopt an unknown existing projection unless overwrite is explicit', async () => {
    await repository.write(projectIntent());
    const projectionPath = service.projectionPath(project);
    mkdirSync(dirname(projectionPath), { recursive: true });
    writeFileSync(projectionPath, 'user-owned-content', 'utf8');

    const conflict = await service.enable(project);
    expect(conflict.status).toBe('conflict');
    expect(readFileSync(projectionPath, 'utf8')).toBe('user-owned-content');
    expect(await repository.getResource(projectProjectionResourceId(project.id))).toBeUndefined();

    const overwritten = await service.enable(project, { overwriteExisting: true });
    expect(overwritten.status).toBe('ready');
    expect(readFileSync(projectionPath, 'utf8')).not.toContain('user-owned-content');
  });

  it('disables or removes only the generated projection and preserves authoritative nodes', async () => {
    await seedProjectionCases();
    await service.enable(project);
    const projectionPath = service.projectionPath(project);
    const nodeIds = (await repository.listNodes('project')).map((node) => node.id).sort();

    const kept = await service.disable(project);
    expect(kept.status).toBe('disabled');
    expect(kept).toMatchObject({ projectionExists: true, safeToRemove: true });
    expect(existsSync(projectionPath)).toBe(true);
    expect(await repository.getResource(projectProjectionResourceId(project.id))).toBeUndefined();

    await service.enable(project);
    const removed = await service.disable(project, { removeProjection: true });
    expect(removed.status).toBe('disabled');
    expect(removed).toMatchObject({ projectionExists: false, safeToRemove: false });
    expect(existsSync(projectionPath)).toBe(false);
    expect((await repository.listNodes('project')).map((node) => node.id).sort()).toEqual(nodeIds);
  });

  it('refuses to remove a projection changed outside LittleSheep', async () => {
    await repository.write(projectIntent());
    await service.enable(project);
    const projectionPath = service.projectionPath(project);
    writeFileSync(projectionPath, 'user-owned-change', 'utf8');

    await expect(service.disable(project, { removeProjection: true })).rejects.toThrow('last verified file');
    expect(readFileSync(projectionPath, 'utf8')).toBe('user-owned-change');
    await expect(service.getState(project)).resolves.toMatchObject({ enabled: true, status: 'conflict' });
  });

  it('writes a stricter shareable export without internal ids, paths, low-confidence or secret entries', async () => {
    await seedProjectionCases();
    const outputPath = join(dataDir, 'exports', 'project-memory.md');
    const result = await service.exportShareable(project, outputPath);
    const content = readFileSync(outputPath, 'utf8');

    expect(result).toMatchObject({ outputPath, entryCount: 1, omittedEntryCount: 3 });
    expect(content).toContain('Use pnpm for verified builds');
    expect(content).toContain('<project-root>');
    expect(content).not.toContain('Possible draft naming convention');
    expect(content).not.toContain('Low frequency implementation detail');
    expect(content).not.toContain('Provider credential');
    expect(content).not.toContain('super-secret-project-value');
    expect(content).not.toContain(projectDir);
    expect(content).not.toContain('run-project-memory');
    expect(content).not.toContain('review-notes.txt');
    expect(content).not.toContain('memoryId');
    expect(await repository.getResource(projectProjectionResourceId(project.id))).toBeUndefined();

    writeFileSync(outputPath, 'user-owned-export', 'utf8');
    await expect(service.exportShareable(project, outputPath)).rejects.toThrow('explicit overwrite approval');
    expect(readFileSync(outputPath, 'utf8')).toBe('user-owned-export');
    await expect(service.exportShareable(project, outputPath, { overwriteExisting: true })).resolves.toMatchObject({
      outputPath,
      entryCount: 1,
    });
  });

  it('recognizes an explicit git ignore rule but never writes it automatically', async () => {
    await repository.write(projectIntent());
    expect((await service.enable(project)).gitIgnored).toBe(false);
    writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\n/.littlesheep/\n', 'utf8');
    expect((await service.getState(project)).gitIgnored).toBe(true);
  });

  it('rejects malformed projection registry entries', async () => {
    mkdirSync(dirname(service.registryPath), { recursive: true });
    writeFileSync(service.registryPath, JSON.stringify({
      version: 1,
      projects: {
        [project.id]: { projectId: project.id, projectName: project.name, projectPath: project.path, enabled: 'yes' },
      },
    }), 'utf8');

    await expect(service.getState(project)).rejects.toThrow('unsupported or invalid format');
  });
});
