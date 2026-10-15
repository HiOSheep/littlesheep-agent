// Owns pending approval UI state and session-scoped approval grants.
import { useEffect, useRef, useState } from 'react'
import type { ApprovalRequest, PermissionSelectionId } from '../api'
import { isPermissionSelectionPreset } from '../../shared/permission-modes'
import {
  SessionApprovalGrantStore,
  createDraftApprovalScopeKey,
  hasReusableSessionApproval,
  isPerCallApprovalRequest,
  sessionApprovalScopeKey,
  type ApprovalReply,
  type ApprovalDecision,
} from '../approval-grants'
import type { PendingApprovalPrompt } from './types'

export function useApprovalController({
  currentSession,
  permissionMode,
}: {
  currentSession: string | undefined
  permissionMode: PermissionSelectionId
}) {
  const [pendingApproval, setPendingApproval] = useState<PendingApprovalPrompt | null>(null)
  const pendingApprovalRef = useRef<PendingApprovalPrompt | null>(null)
  const approvalGrantsRef = useRef(new SessionApprovalGrantStore())
  const draftApprovalScopeRef = useRef(createDraftApprovalScopeKey())

  function openApprovalPrompt(prompt: PendingApprovalPrompt) {
    pendingApprovalRef.current?.resolve('deny')
    pendingApprovalRef.current = prompt
    setPendingApproval(prompt)
  }

  function activeApprovalScopeKey(sessionId = currentSession): string {
    return sessionId ? sessionApprovalScopeKey(sessionId) : draftApprovalScopeRef.current
  }

  function beginDraftApprovalScope(): void {
    approvalGrantsRef.current.clear(draftApprovalScopeRef.current)
    draftApprovalScopeRef.current = createDraftApprovalScopeKey()
  }

  async function requestApprovalForScope(request: ApprovalRequest, scopeKey: string): Promise<ApprovalReply> {
    const perCallApproval = isPerCallApprovalRequest(request)
    // Ordinary calls in a confirmed full-access run need no per-call prompt.
    // Main-marked forced approvals still require a user decision, and changing
    // the current session mode never rewrites an in-flight run's snapshot.
    if (request.permissionMode === 'full' && request.requiresExplicitUserApproval !== true && !request.shellBatch) return true
    if (hasReusableSessionApproval(approvalGrantsRef.current, scopeKey, request)) return true
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      openApprovalPrompt({ request, resolve })
    })
    if (decision === 'session' && !perCallApproval) approvalGrantsRef.current.grant(scopeKey, request)
    if (decision === 'remember-shell') {
      return request.rememberShellCommandAvailable === true
        ? { approved: true, rememberShellCommand: true }
        : false
    }
    return decision !== 'deny'
  }

  function requestWorkspaceSaveApproval(detail: unknown): Promise<boolean> {
    return requestApprovalForScope({
      id: `workspace-save-${Date.now()}`,
      action: 'save_file',
      detail,
      ...(isPermissionSelectionPreset(permissionMode)
        ? { permissionMode: 'research' as const, permissionPreset: permissionMode }
        : { permissionMode }),
      source: 'workspace',
    }, activeApprovalScopeKey()).then(approval => typeof approval === 'boolean' ? approval : approval.approved)
  }

  function requestWorkspaceCommandApproval(detail: unknown): Promise<boolean> {
    return requestApprovalForScope({
      id: `workspace-command-${Date.now()}`,
      action: 'exec',
      detail,
      ...(isPermissionSelectionPreset(permissionMode)
        ? { permissionMode: 'research' as const, permissionPreset: permissionMode }
        : { permissionMode }),
      source: 'workspace',
    }, activeApprovalScopeKey()).then(approval => typeof approval === 'boolean' ? approval : approval.approved)
  }

  function settleApprovalPrompt(decision: ApprovalDecision) {
    const prompt = pendingApprovalRef.current
    if (!prompt) return
    pendingApprovalRef.current = null
    setPendingApproval(null)
    prompt.resolve(decision)
  }

  // A prompt from the previous conversation/permission selection cannot remain
  // actionable in the newly selected scope. Main separately rechecks ownership.
  useEffect(() => { settleApprovalPrompt('deny') }, [currentSession, permissionMode])

  useEffect(() => () => {
    pendingApprovalRef.current?.resolve('deny')
    pendingApprovalRef.current = null
  }, [])

  return {
    pendingApproval,
    approvalGrantsRef,
    activeApprovalScopeKey,
    beginDraftApprovalScope,
    requestApprovalForScope,
    requestWorkspaceSaveApproval,
    requestWorkspaceCommandApproval,
    settleApprovalPrompt,
  }
}

export type ApprovalController = ReturnType<typeof useApprovalController>
