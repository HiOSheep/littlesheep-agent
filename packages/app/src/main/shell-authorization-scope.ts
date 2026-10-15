// Capture live Main-owned ownership facts, independent of Renderer selection or checkpoint JSON.
import type { SessionIndex } from './session-index.js'
import type { ProjectIndex } from './project-index.js'

export async function captureShellAuthorizationScope(input: {
  runId: string; sessionId?: string; projectId?: string; signal?: AbortSignal
  sessionIndex: Pick<SessionIndex, 'list'>; projectIndex: Pick<ProjectIndex, 'list'>
}) {
  const read = async () => {
    const session = input.sessionId ? (await input.sessionIndex.list()).find((value) => value.id === input.sessionId) : undefined
    const project = input.projectId ? (await input.projectIndex.list()).find((value) => value.id === input.projectId) : undefined
    return JSON.stringify({ session: session ? { id: session.id, mode: session.mode, scope: session.scope,
      projectId: session.projectId, workspacePath: session.workspacePath } : null,
      project: project ? { id: project.id, path: project.path, identityVersion: project.identityVersion } : null })
  }
  const baseline = await read()
  return {
    runId: input.runId, sessionId: input.sessionId,
    workspaceId: input.projectId ? `project:${input.projectId}` : input.sessionId ? `session:${input.sessionId}` : `run:${input.runId}`,
    signal: input.signal,
    current: async () => {
      if (input.signal?.aborted) throw new Error('run cancelled')
      const current = await read()
      if (current !== baseline) throw new Error('Main session permission or workspace ownership changed')
      return current
    },
  }
}
