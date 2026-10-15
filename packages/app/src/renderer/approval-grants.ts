import type { PermissionPresetId } from '@littlesheep/types'

export type ApprovalDecision = 'deny' | 'once' | 'session' | 'remember-shell'
export type ApprovalReply = boolean | { approved: true; rememberShellCommand: true }
export type ApprovalSource = 'agent' | 'workspace'

export interface ApprovalGrantTarget {
  action: string
  source?: ApprovalSource
}

export interface ApprovalRequestGrantPolicy extends ApprovalGrantTarget {
  permissionPreset?: PermissionPresetId
  requiresExplicitUserApproval?: boolean
}

/**
 * Main-forced decisions and V2 Agent Shell calls are scoped to one request.
 * They must not reuse or create a conversation-wide grant.
 */
export function isPerCallApprovalRequest(request: ApprovalRequestGrantPolicy): boolean {
  if (request.requiresExplicitUserApproval === true) return true
  const source = request.source ?? 'agent'
  return source === 'agent'
    && request.action.trim().toLowerCase() === 'exec'
    && request.permissionPreset !== undefined
}

const MAX_APPROVAL_SCOPES = 128
const MAX_GRANTS_PER_SCOPE = 64

export function sessionApprovalScopeKey(sessionId: string): string {
  return `session:${sessionId}`
}

export function createDraftApprovalScopeKey(seed = `${Date.now()}-${Math.random().toString(36).slice(2)}`): string {
  return `draft:${seed}`
}

export function approvalGrantKey(target: ApprovalGrantTarget): string {
  const source = target.source ?? 'agent'
  return `${source}:${target.action.trim().toLowerCase()}`
}

/** In-memory only: session grants intentionally disappear when the app exits. */
export class SessionApprovalGrantStore {
  private readonly grants = new Map<string, Set<string>>()

  allows(scopeKey: string, target: ApprovalGrantTarget): boolean {
    return this.grants.get(scopeKey)?.has(approvalGrantKey(target)) ?? false
  }

  grant(scopeKey: string, target: ApprovalGrantTarget): void {
    const existing = this.grants.get(scopeKey) ?? new Set<string>()
    const key = approvalGrantKey(target)
    existing.delete(key)
    existing.add(key)
    while (existing.size > MAX_GRANTS_PER_SCOPE) {
      const oldest = existing.values().next().value as string | undefined
      if (!oldest) break
      existing.delete(oldest)
    }
    if (!this.grants.has(scopeKey) && this.grants.size >= MAX_APPROVAL_SCOPES) {
      const oldestScope = this.grants.keys().next().value as string | undefined
      if (oldestScope) this.grants.delete(oldestScope)
    }
    this.grants.set(scopeKey, existing)
  }

  promote(fromScopeKey: string, toScopeKey: string): void {
    if (fromScopeKey === toScopeKey) return
    const source = this.grants.get(fromScopeKey)
    if (!source) return
    const target = this.grants.get(toScopeKey) ?? new Set<string>()
    for (const key of source) target.add(key)
    while (target.size > MAX_GRANTS_PER_SCOPE) {
      const oldest = target.values().next().value as string | undefined
      if (!oldest) break
      target.delete(oldest)
    }
    if (!this.grants.has(toScopeKey) && this.grants.size >= MAX_APPROVAL_SCOPES) {
      const oldestScope = this.grants.keys().next().value as string | undefined
      if (oldestScope && oldestScope !== fromScopeKey) this.grants.delete(oldestScope)
    }
    this.grants.set(toScopeKey, target)
    this.grants.delete(fromScopeKey)
  }

  clear(scopeKey: string): void {
    this.grants.delete(scopeKey)
  }
}

export function hasReusableSessionApproval(
  grants: SessionApprovalGrantStore,
  scopeKey: string,
  request: ApprovalRequestGrantPolicy,
): boolean {
  return !isPerCallApprovalRequest(request) && grants.allows(scopeKey, request)
}
