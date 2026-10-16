// Rebuild current Main-owned authorization for a safe durable segment.
// Checkpoint values are treated as claims and must match current session,
// project, workspace, and policy state before they reach the Runner.
import { realpath } from 'node:fs/promises'
import type { Config } from '@littlesheep/config'
import type { CreateRunnerOptions, DurableRecoveryAuthorization } from '@littlesheep/runner'
import type { RunCheckpoint, SessionId } from '@littlesheep/types'
import { createHostMemoryAccessGrant } from './memory-access-host.js'
import type { ProjectIndex } from './project-index.js'
import { sameBoundPath } from './path-rebinding.js'
import { resolveRunPolicy } from './run-policy.js'
import type { SessionIndex } from './session-index.js'
import { captureShellAuthorizationScope } from './shell-authorization-scope.js'
import { resolveRunWorkspaceContext } from './local-app-api/run-support.js'

export interface MainRecoveryAuthorizationOptions {
  dataDir: string
  workplaceDir: string
  getConfig: () => Config | undefined
  getSessionIndex: () => SessionIndex | null
  getProjectIndex: () => ProjectIndex | null
  onDecline?: (reason: string, identity: { sessionId: string; runId: string }) => void
}
export function createMainRecoveryAuthorizationResolver(
  getOptions: () => MainRecoveryAuthorizationOptions,
): NonNullable<CreateRunnerOptions['resolveRecoveryAuthorization']> {
  return async ({ sessionId, runId, checkpoint, signal, protectedWriteRoots }) => {
    const options = getOptions()
    const identity = { sessionId: String(sessionId), runId }
    const decline = (reason: string): undefined => {
      if (options.onDecline) options.onDecline(reason, identity)
      else console.warn(`[run-recovery] authorization declined for ${runId}: ${reason}`)
      return undefined
    }
    try {
      if (!safeAppCheckpoint(checkpoint, sessionId, runId)) return decline('checkpoint does not carry a safe app execution context')
      const resume = checkpoint.resumeState!
      const config = options.getConfig()
      const sessions = options.getSessionIndex()
      const projects = options.getProjectIndex()
      if (!config || !sessions || !projects) return decline('Main session or project authority is unavailable')
      const session = (await sessions.list()).find((item) => item.id === identity.sessionId)
      if (!session || session.permissionVersion !== 2 || !session.workspacePath) {
        return decline('current Main session policy or workspace binding is unavailable')
      }

      let ownership: { scope: 'standalone' | 'project'; projectId?: string }
      let workspacePath: string
      if (session.scope === 'project') {
        if (!session.projectId) return decline('project session has no current project identity')
        const project = (await projects.list()).find((item) => item.id === session.projectId)
        if (!project || project.identityVersion !== 2) return decline('current project identity cannot be verified')
        const [projectPath, indexedPath, checkpointPath] = await Promise.all([
          realpath(project.path), realpath(session.workspacePath), realpath(resume.cwd),
        ])
        if (!sameBoundPath(projectPath, indexedPath) || !sameBoundPath(projectPath, checkpointPath)) {
          return decline('project workspace changed since the safe checkpoint')
        }
        ownership = { scope: 'project', projectId: project.id }
        workspacePath = projectPath
      } else {
        if (session.projectId) return decline('standalone session contains an inconsistent project binding')
        const [indexedPath, checkpointPath] = await Promise.all([
          realpath(session.workspacePath), realpath(resume.cwd),
        ])
        if (!sameBoundPath(indexedPath, checkpointPath)) return decline('session workspace changed since the safe checkpoint')
        ownership = { scope: 'standalone' }
        workspacePath = indexedPath
      }

      const workspaceContext = resolveRunWorkspaceContext(workspacePath, ownership, options.workplaceDir)
      if (!resume.workspaceContext
        || resume.workspaceContext.boundaryKind !== workspaceContext.boundaryKind
        || resume.workspaceContext.projectId !== workspaceContext.projectId) {
        return decline('checkpoint workspace context does not match current Main ownership')
      }

      const shellScope = await captureShellAuthorizationScope({
        runId,
        sessionId: identity.sessionId,
        projectId: ownership.projectId,
        signal,
        sessionIndex: sessions,
        projectIndex: projects,
      })
      const policy = resolveRunPolicy({ permissionPreset: session.mode }, config, undefined, {
        containerRoot: options.dataDir,
        dataRoot: options.dataDir,
        workspaceRoot: workspacePath,
        protectedRoots: protectedWriteRoots,
        cwd: workspacePath,
        fullAccessConfirmed: session.mode === 'full-access',
        shellScope,
        // Process-local repeat approvals are intentionally not resurrected.
        shellRepeatAuthorization: { consume: () => false },
      })
      if (!policy.permissionPolicyV2 || policy.permissionPolicyId !== resume.permissionPolicyId) {
        return decline('current Permission V2 policy cannot be matched to the checkpoint')
      }
      const memoryAccessGrant = await createHostMemoryAccessGrant({
        dataDir: options.dataDir,
        runId,
        sessionId: identity.sessionId,
        workspace: workspacePath,
        ownership,
        sessionIndex: sessions,
        projectIndex: projects,
      })
      return {
        permissionPolicyId: policy.permissionPolicyId,
        permissionPreset: policy.permissionPreset,
        permissionPolicyV2: policy.permissionPolicyV2,
        approve: policy.approve,
        memoryAccessGrant,
        workspaceContext,
      } satisfies DurableRecoveryAuthorization
    } catch (error) {
      return decline(`current Main authorization could not be rebuilt: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function safeAppCheckpoint(checkpoint: RunCheckpoint, sessionId: SessionId, runId: string): boolean {
  return checkpoint.runId === runId
    && String(checkpoint.sessionId) === String(sessionId)
    && checkpoint.resumeState?.origin === 'app'
    && checkpoint.resumeState.attachmentCount === 0
    && !!checkpoint.safeSegmentBoundary
    && !!checkpoint.resumeState.cwd
}
