import { lstat, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { atomicWrite } from '@littlesheep/memory-core'
import { isPathInsideOrSameBound, rebaseBoundPath } from './path-rebinding.js'

const FIXED_METADATA_FILES = [
  'config.json',
  'sessions.json',
  join('projects', 'index.json'),
  join('archive', 'index.json'),
  join('workspace', 'artifacts.json'),
  join('workspace', 'layout.json'),
  join('workspace', 'terminal-activity.json'),
  join('memory-tree', 'index.json'),
  join('memory-tree', 'project-projections.json'),
] as const

export interface DataRootMetadataRebindReport {
  inspectedFiles: number
  changedFiles: number
  replacements: number
}

export async function rebindDataRootMetadata(
  stagedDataRoot: string,
  sourceDataRoot: string,
  targetDataRoot: string,
): Promise<DataRootMetadataRebindReport> {
  const stagedRoot = resolve(stagedDataRoot)
  const sourceRoot = resolve(sourceDataRoot)
  const targetRoot = resolve(targetDataRoot)
  const files = [
    ...FIXED_METADATA_FILES.map((entry) => join(stagedRoot, entry)),
    ...await listResourceIndexes(join(stagedRoot, 'workspace', 'resource-indexes')),
  ]
  let inspectedFiles = 0
  let changedFiles = 0
  let replacements = 0

  for (const filePath of files) {
    if (!isPathInsideOrSameBound(stagedRoot, filePath)) continue
    const info = await safeLstat(filePath)
    if (!info?.isFile() || info.isSymbolicLink()) continue
    inspectedFiles += 1
    const raw = await readFile(filePath, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      continue
    }
    const result = rebindJsonValue(parsed, sourceRoot, targetRoot)
    if (!result.changed) continue
    replacements += result.replacements
    changedFiles += 1
    await atomicWrite(filePath, JSON.stringify(result.value, null, 2))
  }

  return { inspectedFiles, changedFiles, replacements }
}

async function listResourceIndexes(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
      .map((entry) => join(directory, entry.name))
  } catch {
    return []
  }
}

async function safeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch {
    return undefined
  }
}

interface RebindResult {
  value: unknown
  changed: boolean
  replacements: number
}

function rebindJsonValue(value: unknown, sourceRoot: string, targetRoot: string): RebindResult {
  if (typeof value === 'string') {
    const rebound = rebindMetadataString(value, sourceRoot, targetRoot)
    return {
      value: rebound,
      changed: rebound !== value,
      replacements: rebound === value ? 0 : 1,
    }
  }
  if (Array.isArray(value)) {
    let changed = false
    let replacements = 0
    const next = value.map((entry) => {
      const result = rebindJsonValue(entry, sourceRoot, targetRoot)
      changed ||= result.changed
      replacements += result.replacements
      return result.value
    })
    return { value: changed ? next : value, changed, replacements }
  }
  if (!value || typeof value !== 'object') {
    return { value, changed: false, replacements: 0 }
  }

  let changed = false
  let replacements = 0
  const next: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const reboundKey = rebindMetadataString(key, sourceRoot, targetRoot)
    const result = rebindJsonValue(entry, sourceRoot, targetRoot)
    changed ||= reboundKey !== key || result.changed
    replacements += (reboundKey === key ? 0 : 1) + result.replacements
    next[reboundKey] = result.value
  }
  return { value: changed ? next : value, changed, replacements }
}

function rebindMetadataString(value: string, sourceRoot: string, targetRoot: string): string {
  if (isAbsolute(value) && isPathInsideOrSameBound(sourceRoot, value)) {
    return rebaseBoundPath(value, sourceRoot, targetRoot)
  }

  const fileTab = value.match(/^file:([^|]+)\|(.+)$/u)
  if (fileTab) {
    try {
      const root = decodeURIComponent(fileTab[1]!)
      const path = decodeURIComponent(fileTab[2]!)
      const nextRoot = rebindAbsolutePath(root, sourceRoot, targetRoot)
      const nextPath = rebindAbsolutePath(path, sourceRoot, targetRoot)
      if (nextRoot !== root || nextPath !== path) {
        return `file:${encodeURIComponent(nextRoot)}|${encodeURIComponent(nextPath)}`
      }
    } catch {
      return value
    }
  }

  if (value.startsWith('file:')) {
    const suffix = value.slice('file:'.length)
    const rebound = rebindAbsolutePath(suffix, sourceRoot, targetRoot)
    if (rebound !== suffix) return `file:${rebound}`
  }

  return value
}

function rebindAbsolutePath(value: string, sourceRoot: string, targetRoot: string): string {
  if (!isAbsolute(value) || !isPathInsideOrSameBound(sourceRoot, value)) return value
  return rebaseBoundPath(value, sourceRoot, targetRoot)
}
