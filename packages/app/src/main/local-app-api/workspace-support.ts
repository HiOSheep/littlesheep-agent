// Shared workspace boundary and resource-index helpers for Local App API routes.

import { isAbsolute, relative, resolve } from 'node:path'
import type { Config } from '@littlesheep/config'
import type { AgentRunner, RunInput } from '@littlesheep/runner'
import type { ProjectIndex } from '../project-index.js'
import { sameBoundPath } from '../path-rebinding.js'
import { HttpError } from './http.js'

export function resolveWorkspaceRoot(url: URL, config: Config, workplaceDir: string): string {
  return resolveWorkspaceRootFromValue(url.searchParams.get('root'), config, workplaceDir)
}

export function resolveWorkspaceRootFromValue(
  value: unknown,
  config: Config,
  workplaceDir: string,
): string {
  const requested = typeof value === 'string' ? value.trim() : ''
  return resolve(requested || config.agents.defaults.workspace || workplaceDir)
}

export function resolveWorkspaceTarget(root: string, value: string): string {
  if (!value.trim()) throw new HttpError(400, 'workspace path is required')
  const target = resolve(root, value)
  if (!isPathInsideOrSame(root, target)) {
    throw new HttpError(403, 'workspace path is outside the selected workspace')
  }
  return target
}

export function isPathInsideOrSame(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child)
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent))
}

export async function resolveWorkspaceContextForPath(
  projectIndex: ProjectIndex,
  workspacePath: string,
  workplaceDir: string,
): Promise<NonNullable<RunInput['workspaceContext']>> {
  const project = (await projectIndex.list()).find((item) => sameBoundPath(item.path, workspacePath))
  return project
    ? { boundaryKind: 'project', projectId: project.id }
    : { boundaryKind: sameBoundPath(workspacePath, workplaceDir) ? 'agent_workplace' : 'user_workplace' }
}

export async function syncWorkspaceResourceChanges(
  runner: AgentRunner,
  workspacePath: string,
  options: Parameters<AgentRunner['infra']['memoryService']['syncWorkspaceResources']>[1],
): Promise<void> {
  try {
    await runner.infra.memoryService.syncWorkspaceResources(workspacePath, options)
  } catch (error) {
    console.error(`[workspace-index] incremental sync degraded: ${(error as Error).message}`)
  }
}

export function normalizeOptionalSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function normalizePositiveInt(value: unknown, fallback: number, max: number): number {
  const raw = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(raw)) return fallback
  return Math.max(1, Math.min(max, Math.round(raw)))
}
