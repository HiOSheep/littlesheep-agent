// @littlesheep/app — runtime-config.ts
// Pure runtime config helpers used by Electron main process.

import { dirname, resolve } from 'node:path'

export interface RuntimeWorkspaceResolution {
  workspace: string
  migrated: boolean
}

export function resolveRuntimeWorkspaceDefault(
  defaultWorkspace: string | undefined,
  workplaceDir: string | undefined,
  cwd = process.cwd(),
): RuntimeWorkspaceResolution {
  const requested = defaultWorkspace?.trim() ?? ''
  const workplace = workplaceDir?.trim() ?? ''

  if (!workplace) return { workspace: requested, migrated: false }
  if (!requested) return { workspace: workplace, migrated: true }
  if (samePath(requested, cwd)) return { workspace: workplace, migrated: true }
  if (isRetiredApplicationWorkspace(requested, workplace)) return { workspace: workplace, migrated: true }
  return { workspace: requested, migrated: false }
}

export function isRetiredApplicationWorkspace(value: string, workplaceDir?: string): boolean {
  // Older prototypes used a hidden application directory with a generic
  // `workspace` child. Keep migration based on that shape, not a brand name.
  const normalized = normalizePath(value)
  const segments = normalized.split(/[\\/]+/).filter(Boolean)
  const leaf = segments.at(-1)
  const parent = segments.at(-2)
  if (leaf !== 'workspace' || !parent?.startsWith('.') || parent === '.littlesheep') return false
  if (!workplaceDir) return true

  // A hidden `workspace` elsewhere may be a deliberate project. Only migrate
  // retired application data that shares the same owner root as LS user data.
  return samePath(dirname(dirname(normalized)), dirname(dirname(normalizePath(workplaceDir))))
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right)
}

function normalizePath(value: string): string {
  return resolve(value).replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
}
