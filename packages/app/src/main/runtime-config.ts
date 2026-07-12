// @littlesheep/app — runtime-config.ts
// Pure runtime config helpers used by Electron main process.

import { resolve } from 'node:path'

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
  if (isRetiredApplicationWorkspace(requested)) return { workspace: workplace, migrated: true }
  return { workspace: requested, migrated: false }
}

function isRetiredApplicationWorkspace(value: string): boolean {
  // Older prototypes used a hidden application directory with a generic
  // `workspace` child. Keep migration based on that shape, not a brand name.
  const segments = normalizePath(value).split('\\').filter(Boolean)
  const leaf = segments.at(-1)
  const parent = segments.at(-2)
  return leaf === 'workspace' && Boolean(parent?.startsWith('.') && parent !== '.littlesheep')
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right)
}

function normalizePath(value: string): string {
  return resolve(value).replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
}
