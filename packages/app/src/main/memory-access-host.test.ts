import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bindMemoryAccessGrant, inspectMemoryAccessContext, memoryAccessContextIsCurrent, memoryAccessRootId } from '@littlesheep/memory-tree';
import { ProjectIndex } from './project-index.js';
import { SessionIndex } from './session-index.js';
import { createHostMemoryAccessGrant } from './memory-access-host.js';
import { resolveRunSessionOwnership } from './local-app-api/run-support.js';
let root: string, workspace: string, projects: ProjectIndex, sessions: SessionIndex;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ls-access-host-')); workspace = join(root, 'project');
  await mkdir(workspace); projects = new ProjectIndex({ dataDir: root }); sessions = new SessionIndex({ dataDir: root }); });
afterEach(async () => { const target = resolve(root); if (!target.startsWith(resolve(tmpdir()) + '\\')) throw new Error('Invalid fixture cleanup'); await rm(target, { recursive: true, force: true }); });
describe('Main registry-backed memory identity', () => {
  it('keeps display activity separate from binding revision and revokes deleted projects', async () => {
    const project = await projects.ensure(workspace);
    await sessions.upsert('s', { scope: 'project', projectId: project.id, workspacePath: workspace });
    const context = await bindMemoryAccessGrant(await createHostMemoryAccessGrant({ dataDir: root, runId: 'r', sessionId: 's', workspace,
      ownership: { scope: 'project', projectId: project.id }, sessionIndex: sessions, projectIndex: projects }),
      { runId: 'r', sessionId: 's', workspace }, memoryAccessRootId(root));
    await projects.touch(project.id, new Date(Date.now() + 1000));
    expect(await memoryAccessContextIsCurrent(context)).toBe(true);
    await projects.remove(project.id);
    expect(await memoryAccessContextIsCurrent(context)).toBe(false);
  });
  it('uses restricted authority for a named unindexed session and revokes changed indexed ownership', async () => {
    const project = await projects.ensure(workspace);
    const options = { dataDir: root, runId: 'r', sessionId: 's', workspace,
      ownership: { scope: 'project' as const, projectId: project.id }, sessionIndex: sessions, projectIndex: projects };
    const context = await bindMemoryAccessGrant(await createHostMemoryAccessGrant(options),
      { runId: 'r', sessionId: 's', workspace }, memoryAccessRootId(root));
    expect(inspectMemoryAccessContext(context, { runId: 'r', sessionId: 's', rootId: memoryAccessRootId(root) }))
      .toMatchObject({ source: 'standalone-adapter', policy: { readMode: 'none', writeMode: 'disabled' } });
    await sessions.upsert('s', { scope: 'standalone' });
    expect(await memoryAccessContextIsCurrent(context)).toBe(false);
  });
  it('binds a verified stable project and invalidates old grants after rebind', async () => {
    const project = await projects.ensure(workspace);
    await sessions.upsert('s', { scope: 'project', projectId: project.id, workspacePath: workspace });
    const options = { dataDir: root, runId: 'r', sessionId: 's', workspace, ownership: { scope: 'project' as const, projectId: project.id }, sessionIndex: sessions, projectIndex: projects };
    const context = await bindMemoryAccessGrant(await createHostMemoryAccessGrant(options), { runId: 'r', sessionId: 's', workspace }, memoryAccessRootId(root));
    const snapshot = inspectMemoryAccessContext(context, { runId: 'r', sessionId: 's', rootId: memoryAccessRootId(root) });
    expect(snapshot.policy.projectId).toBe(project.id); expect(snapshot.projectIdentityVersion).toBe(2);
    expect(await memoryAccessContextIsCurrent(context)).toBe(true);
    const moved = join(root, 'moved'); await mkdir(moved); await projects.rebind(project.id, moved);
    expect(await memoryAccessContextIsCurrent(context)).toBe(false);
    const restricted = await bindMemoryAccessGrant(await createHostMemoryAccessGrant(options), { runId: 'r', sessionId: 's', workspace }, memoryAccessRootId(root));
    expect(inspectMemoryAccessContext(restricted, { runId: 'r', sessionId: 's', rootId: memoryAccessRootId(root) }).policy.projectId).toBeUndefined();
    await sessions.upsert('s', { workspacePath: moved });
    const fresh = await createHostMemoryAccessGrant({ ...options, runId: 'new', workspace: moved });
    const newContext = await bindMemoryAccessGrant(fresh, { runId: 'new', sessionId: 's', workspace: moved }, memoryAccessRootId(root));
    expect(inspectMemoryAccessContext(newContext, { runId: 'new', sessionId: 's', rootId: memoryAccessRootId(root) }).policy.projectId).toBe(project.id);
  });
  it('does not infer project access from cwd, descendants, or missing registry IDs', async () => {
    const project = await projects.ensure(workspace); const child = join(workspace, 'child'); await mkdir(child);
    const base = { dataDir: root, runId: 'r', workspace, ownership: { scope: 'standalone' as const }, sessionIndex: sessions, projectIndex: projects };
    const context = await bindMemoryAccessGrant(await createHostMemoryAccessGrant(base), { runId: 'r', sessionId: 'new', workspace }, memoryAccessRootId(root));
    expect(inspectMemoryAccessContext(context, { runId: 'r', sessionId: 'new', rootId: memoryAccessRootId(root) }).policy.projectId).toBeUndefined();
    for (const [id, path] of [[project.id, child], ['missing', workspace]]) await expect(createHostMemoryAccessGrant({ ...base, workspace: path!, ownership: { scope: 'project', projectId: id } })).rejects.toThrow();
  });
  it('rejects Renderer policy claims and forged project ownership of an existing standalone session', async () => {
    await sessions.upsert('s', { scope: 'standalone' });
    await expect(resolveRunSessionOwnership(sessions, projects, { sessionId: 's', projectId: 'forged' })).rejects.toThrow();
    for (const key of ['memoryAccessPolicy', 'memoryAccessGrant', 'memoryAccessContext', 'memoryPolicy']) {
      await expect(resolveRunSessionOwnership(sessions, projects, { sessionId: 's', [key]: {} })).rejects.toThrow();
    }
  });
});
