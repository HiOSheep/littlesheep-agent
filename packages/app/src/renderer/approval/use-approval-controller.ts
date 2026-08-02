// Owns pending approval UI state and session-scoped approval grants.
import { useEffect, useRef, useState } from 'react'
import type { ApprovalRequest, PermissionModeId } from '../api'
import {
  SessionApprovalGrantStore,
  createDraftApprovalScopeKey,
  sessionApprovalScopeKey,
  type ApprovalDecision,
} from '../approval-grants'
import type { PendingApprovalPrompt } from './types'

export function useApprovalController({
  currentSession,
  permissionMode,
}: {
  currentSession: string | undefined
  permissionMode: PermissionModeId
}) {
  const [pendingApproval, setPendingApproval] = useState<PendingApprovalPrompt | null>(null)
  const pendingApprovalRef = useRef<PendingApprovalPrompt | null>(null)
  const permissionModeRef = useRef(permissionMode)
  const approvalGrantsRef = useRef(new SessionApprovalGrantStore())
  const draftApprovalScopeRef = useRef(createDraftApprovalScopeKey())
  permissionModeRef.current = permissionMode

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

  async function requestApprovalForScope(request: ApprovalRequest, scopeKey: string): Promise<boolean> {
    // The user accepts the host-wide risk once when enabling full access.
    // Current-mode lookup also lets an in-flight run continue without leaving
    // an approval prompt behind after the user confirms the mode change.
    if (permissionModeRef.current === 'full' || request.permissionMode === 'full') return true
    if (approvalGrantsRef.current.allows(scopeKey, request)) return true
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      openApprovalPrompt({ request, resolve })
    })
    if (decision === 'session') approvalGrantsRef.current.grant(scopeKey, request)
    return decision !== 'deny'
  }

  function requestWorkspaceSaveApproval(detail: unknown): Promise<boolean> {
    return requestApprovalForScope({
      id: `workspace-save-${Date.now()}`,
      action: 'save_file',
      detail,
      permissionMode,
      source: 'workspace',
    }, activeApprovalScopeKey())
  }

  function requestWorkspaceCommandApproval(detail: unknown): Promise<boolean> {
    return requestApprovalForScope({
      id: `workspace-command-${Date.now()}`,
      action: 'exec',
      detail,
      permissionMode,
      source: 'workspace',
    }, activeApprovalScopeKey())
  }

  function settleApprovalPrompt(decision: ApprovalDecision) {
    const prompt = pendingApprovalRef.current
    if (!prompt) return
    pendingApprovalRef.current = null
    setPendingApproval(null)
    prompt.resolve(decision)
  }

  useEffect(() => {
    if (permissionMode !== 'full') return
    const prompt = pendingApprovalRef.current
    if (!prompt) return
    pendingApprovalRef.current = null
    setPendingApproval(null)
    prompt.resolve('once')
  }, [permissionMode])

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
