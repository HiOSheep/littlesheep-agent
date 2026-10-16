import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { ShellExecutionDescription } from '@littlesheep/types'

export const SHELL_REPEAT_AUTHORIZATION_TTL_MS = 30 * 60 * 1000
export const SHELL_REPEAT_AUTHORIZATION_MAX_USES = 20
const MAX_AUTHORIZATIONS = 256

interface ShellRepeatAuthorization {
  id: string
  sessionId: string
  binding: string
  description: ShellExecutionDescription
  createdAt: number
  expiresAt: number
  remainingUses: number
}

/** Main-process memory only. No API accepts a caller-supplied binding or authorization id for execution. */
export class ShellRepeatAuthorizationStore {
  private readonly authorizations = new Map<string, ShellRepeatAuthorization>()

  canRemember(description: ShellExecutionDescription): boolean {
    if (!isRepeatCandidate(description)) return false
    this.prune(Date.now())
    return this.authorizations.size < MAX_AUTHORIZATIONS
      || [...this.authorizations.values()].some((value) => value.sessionId === description.sessionId)
  }

  remember(description: ShellExecutionDescription, now = Date.now()): (() => void) | undefined {
    if (!isRepeatCandidate(description)) return undefined
    const binding = authorizationBinding(description)
    this.prune(now)
    const hasCurrentSessionGrant = [...this.authorizations.values()]
      .some((value) => value.sessionId === description.sessionId)
    if (this.authorizations.size >= MAX_AUTHORIZATIONS && !hasCurrentSessionGrant) return undefined

    // A new decision for this session replaces stale facts, while an identical
    // explicit decision starts a fresh, visible bounded window.
    for (const [id, value] of this.authorizations) {
      if (value.sessionId === description.sessionId) this.authorizations.delete(id)
    }

    const authorization: ShellRepeatAuthorization = {
      id: randomUUID(),
      sessionId: description.sessionId,
      binding,
      description: cloneDescription(description),
      createdAt: now,
      expiresAt: now + SHELL_REPEAT_AUTHORIZATION_TTL_MS,
      remainingUses: SHELL_REPEAT_AUTHORIZATION_MAX_USES,
    }
    this.authorizations.set(authorization.id, authorization)
    return () => {
      if (this.authorizations.get(authorization.id) === authorization) this.authorizations.delete(authorization.id)
    }
  }

  /** Synchronous consumption makes the remaining-use limit safe under concurrent runs. */
  consume(description: ShellExecutionDescription, now = Date.now()): boolean {
    this.prune(now)
    let matching: ShellRepeatAuthorization | undefined
    const eligible = isRepeatCandidate(description)
    const binding = eligible ? authorizationBinding(description) : undefined

    for (const [id, value] of this.authorizations) {
      if (value.sessionId !== description.sessionId) continue
      if (binding && value.binding === binding) matching = value
      else this.authorizations.delete(id)
    }
    if (!matching) return false
    matching.remainingUses -= 1
    if (matching.remainingUses <= 0) this.authorizations.delete(matching.id)
    return true
  }

  invalidateSession(sessionId: string): void {
    for (const [id, authorization] of this.authorizations) {
      if (authorization.sessionId === sessionId) this.authorizations.delete(id)
    }
  }

  invalidateWorkspace(workspaceId: string): void {
    for (const [id, authorization] of this.authorizations) {
      if (authorization.description.workspace.id === workspaceId) this.authorizations.delete(id)
    }
  }

  clear(): void {
    this.authorizations.clear()
  }

  private prune(now: number): void {
    for (const [id, authorization] of this.authorizations) {
      if (authorization.expiresAt <= now || authorization.remainingUses <= 0) this.authorizations.delete(id)
    }
  }
}

/** A repeat grant binds one exact Main-reviewed execution plan, including the raw command text. */
export function isRepeatCandidate(description: ShellExecutionDescription): boolean {
  if (description.version !== 1 || description.action !== 'exec' || description.source !== 'agent'
    || typeof description.command !== 'string' || description.command.trim().length === 0
    || !Number.isSafeInteger(description.timeoutMs) || description.timeoutMs <= 0
    || !description.sessionId || !description.runId || !description.workspace.id
    || !description.user || !description.permission || !description.environment
    || description.cwd.path !== description.workspace.path
    || description.cwd.identity !== description.workspace.identity
    || !isAbsolute(description.shell.path) || !description.shell.identity
    || !isAbsolute(description.cwd.path) || !description.cwd.identity
    || !isAbsolute(description.workspace.path) || !description.workspace.identity) return false

  const expectedArgs = process.platform === 'win32' ? ['-NoProfile', '-Command'] : ['-c']
  return description.shell.args.length === expectedArgs.length
    && description.shell.args.every((argument, index) => argument === expectedArgs[index])
}

function authorizationBinding(description: ShellExecutionDescription): string {
  // runId, invocationId and digest identify a single execution, so they are
  // intentionally omitted. Every scope and effective execution fact remains.
  return JSON.stringify([
    description.version,
    description.action,
    description.command,
    description.shell.path,
    description.shell.args,
    description.shell.identity,
    description.cwd.path,
    description.cwd.identity,
    description.workspace.id,
    description.workspace.path,
    description.workspace.identity,
    description.sessionId,
    description.permission,
    description.environment,
    description.timeoutMs,
    description.source,
    description.user,
  ])
}

function cloneDescription(description: ShellExecutionDescription): ShellExecutionDescription {
  return {
    ...description,
    shell: { ...description.shell, args: [...description.shell.args] },
    cwd: { ...description.cwd },
    workspace: { ...description.workspace },
  }
}

