// Main resolves registry ownership; Renderer sends intent, never an authorization snapshot.
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { issueMemoryAccessGrant, memoryAccessRootId, type MemoryAccessGrant } from '@littlesheep/memory-tree';
import type { ProjectIndex, ProjectMeta } from './project-index.js';
import type { SessionIndex } from './session-index.js';
import { sameBoundPath } from './path-rebinding.js';

async function projectRevision(p: ProjectMeta): Promise<string> {
  return createHash('sha256').update(JSON.stringify([p.id, await realpath(p.path), p.identityVersion ?? 1, p.pathUpdatedAt ?? p.createdAt])).digest('hex');
}
async function executionPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A not-yet-created standalone workplace conveys no project authority.
    return resolve(path);
  }
}
export async function createHostMemoryAccessGrant(options: {
  dataDir: string; runId: string; sessionId?: string; workspace: string;
  ownership: { scope: 'standalone' | 'project'; projectId?: string };
  sessionIndex: SessionIndex; projectIndex: ProjectIndex;
}): Promise<MemoryAccessGrant> {
  const rootId = memoryAccessRootId(options.dataDir);
  const workspace = await executionPath(options.workspace);
  const project = options.ownership.projectId
    ? (await options.projectIndex.list()).find((p) => p.id === options.ownership.projectId) : undefined;
  const initialSession = options.sessionId ? (await options.sessionIndex.list()).find((s) => s.id === options.sessionId) : undefined;
  const projectWorkspaceVerified = !!project && sameBoundPath(await realpath(project.path), workspace);
  const sessionExecutionVerified = initialSession?.scope === 'project' && initialSession.projectId === project?.id
    && !!initialSession.workspacePath && sameBoundPath(await executionPath(initialSession.workspacePath), workspace);
  if (options.ownership.scope === 'project' && (!project || (!projectWorkspaceVerified && !sessionExecutionVerified))) {
    throw new Error('Memory project identity is missing or workspace binding is invalid');
  }
  if (options.ownership.scope !== 'project' && options.ownership.projectId) throw new Error('Invalid memory project ownership');
  const fingerprint = project ? await projectRevision(project) : undefined;
  let boundSession = options.sessionId;
  let sawIndexedSession = !!initialSession;
  const current = async () => {
    if (memoryAccessRootId(options.dataDir) !== rootId || !sameBoundPath(await executionPath(options.workspace), workspace)) return false;
    if (boundSession) {
      const session = (await options.sessionIndex.list()).find((s) => s.id === boundSession);
      // New sessions enter the display index at settlement, after Runner creates authoritative JSONL.
      if (session && (session.scope !== options.ownership.scope || session.projectId !== options.ownership.projectId)) return false;
      if (session?.workspacePath && !sameBoundPath(await executionPath(session.workspacePath), workspace)) return false;
      if (!session && sawIndexedSession) return false;
      if (session) sawIndexedSession = true;
    }
    if (!project) return true;
    const now = (await options.projectIndex.list()).find((p) => p.id === project.id);
    return !!now && await projectRevision(now) === fingerprint;
  };
  if (!await current()) throw new Error('Stale memory session or project identity');
  return issueMemoryAccessGrant({ rootId, runId: options.runId, sessionId: options.sessionId,
    workspace: options.workspace, current, resolve: async (binding) => {
      boundSession = binding.sessionId;
      const compatibility = (!!options.sessionId && !initialSession) || (!!project && !projectWorkspaceVerified);
      const authorizedProject = compatibility ? undefined : project;
      return { source: compatibility ? 'standalone-adapter' : 'host', projectIdentityVersion: authorizedProject?.identityVersion ?? (authorizedProject ? 1 : undefined),
        projectBindingRevision: authorizedProject ? fingerprint : undefined, policy: {
          version: 1, revision: 0, principalId: `local:${rootId}`, dataRootId: rootId,
          sessionId: binding.sessionId, runId: binding.runId, projectId: authorizedProject?.id,
          readMode: authorizedProject ? 'project' : 'none', writeMode: compatibility ? 'disabled' : 'ask', selected: [], disabled: [], globalWriteGranted: false,
        } };
    } });
}
