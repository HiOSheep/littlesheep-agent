// Bounded filesystem, version detection and import helpers for toolchains.

import { execFile } from 'node:child_process'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { atomicWrite } from '@littlesheep/memory-core'
import {
  DEVELOPMENT_ENVIRONMENT_IDS,
  normalizeDevelopmentEnvironmentVersion,
  type DevelopmentEnvironmentId,
  type DevelopmentEnvironmentPreferences,
} from '../shared/development-environment-contracts.js'
import type { EnvironmentDefinition } from './development-environment-definitions.js'

const execFileAsync = promisify(execFile)
const DETECTION_TIMEOUT_MS = 1_800
export const STAGING_DIRECTORY = '.staging'

export async function readPreferences(path: string): Promise<DevelopmentEnvironmentPreferences> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { versions?: Record<string, unknown> }
    const versions: Partial<Record<DevelopmentEnvironmentId, string>> = {}
    for (const id of DEVELOPMENT_ENVIRONMENT_IDS) {
      const value = raw.versions?.[id]
      const normalized = typeof value === 'string' ? normalizeRequestedVersion(value) : null
      if (normalized) versions[id] = normalized
    }
    return { versions }
  } catch {
    return { versions: {} }
  }
}

export async function listManagedVersions(path: string, definition: EnvironmentDefinition): Promise<string[]> {
  const versions = await listChildDirectories(path)
  return versions.filter((version) => version !== STAGING_DIRECTORY && !(definition.id === 'node' && version === 'bin'))
}

export async function findFirstFile(root: string, candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const path = join(root, candidate)
    try {
      const info = await lstat(path)
      if (info.isFile() && !info.isSymbolicLink()) return path
    } catch {
      // Try the next portable layout.
    }
  }
  return null
}

export async function findImportExecutable(
  definition: EnvironmentDefinition,
  source: string,
): Promise<{ path: string; root: string } | null> {
  const direct = await findFirstFile(source, definition.managedCandidates)
  if (direct) return { path: direct, root: source }
  try {
    const entries = await readdir(source, { withFileTypes: true })
    for (const entry of entries.filter((item) => item.isDirectory() && !item.isSymbolicLink())) {
      const nestedRoot = join(source, entry.name)
      const nested = await findFirstFile(nestedRoot, definition.managedCandidates)
      if (nested) return { path: nested, root: nestedRoot }
    }
  } catch {
    return null
  }
  return null
}

export async function assertNoSymlinks(root: string): Promise<void> {
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('工具链根目录必须是普通目录，不能是符号链接')
  }
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('工具链目录包含符号链接，出于安全原因无法导入')
      if (entry.isDirectory()) pending.push(join(current, entry.name))
    }
  }
}

export async function findSystemExecutable(
  definition: EnvironmentDefinition,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): Promise<string | null> {
  for (const name of definition.executableNames) {
    const command = platform === 'win32' ? 'where.exe' : 'which'
    try {
      const result = await execFileAsync(command, [name], {
        timeout: DETECTION_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 32 * 1024,
        env: environment,
      })
      const path = String(result.stdout).split(/\r?\n/u).map((line) => line.trim()).find(Boolean)
      if (path) return path
    } catch {
      // A missing executable is an expected status, not an application error.
    }
  }
  return null
}

export async function readVersion(
  executable: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<string | null> {
  try {
    const result = await execFileAsync(executable, args, {
      timeout: DETECTION_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 32 * 1024,
      env: { ...process.env, ...extraEnv },
    })
    const output = `${String(result.stdout)}\n${String(result.stderr)}`
    return extractVersion(output)
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string }
    return extractVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }
}

export function normalizeRequestedVersion(value: string | null | undefined): string | null {
  return normalizeDevelopmentEnvironmentVersion(value)
}

export function canonicalVersionLabel(value: string | null): string | null {
  const normalized = normalizeRequestedVersion(value)
  return normalized?.replace(/^v(?=\d)/iu, '') ?? null
}

export function versionMatchesPreference(actual: string, requested: string): boolean {
  const normalizedActual = canonicalVersionLabel(actual) ?? actual.replace(/^v(?=\d)/iu, '')
  const normalizedRequested = canonicalVersionLabel(requested) ?? requested.replace(/^v(?=\d)/iu, '')
  return normalizedActual === normalizedRequested || normalizedActual.startsWith(`${normalizedRequested}.`)
}

export function managedPathEntries(versionRoot: string, executable: string, platform: NodeJS.Platform): string[] {
  const relativePath = relative(versionRoot, executable).replace(/\\/gu, '/')
  const entries = [dirname(executable)]
  if (relativePath.startsWith('bin/')) entries.push(join(versionRoot, 'bin'))
  if (relativePath.startsWith('cmd/')) entries.push(join(versionRoot, 'cmd'))
  entries.push(versionRoot)
  return uniquePaths(entries, platform)
}

export function uniquePaths(paths: string[], platform = process.platform): string[] {
  const seen = new Set<string>()
  return paths.filter((path) => {
    const key = platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function writeIfChanged(path: string, content: string): Promise<void> {
  try {
    if (await readFile(path, 'utf8') === content) return
  } catch {
    // The file does not exist yet.
  }
  await atomicWrite(path, content)
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

export function isPathWithin(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate))
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
}

export function isDirectChild(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate))
  return relativePath.length > 0
    && !relativePath.startsWith(`..${sep}`)
    && relativePath !== '..'
    && !isAbsolute(relativePath)
    && !relativePath.includes(sep)
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

async function listChildDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && normalizeRequestedVersion(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
  } catch {
    return []
  }
}

function extractVersion(output: string): string | null {
  const match = output.match(/\b(?:v)?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?\b/u)
  return match?.[0] ?? output.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null
}
