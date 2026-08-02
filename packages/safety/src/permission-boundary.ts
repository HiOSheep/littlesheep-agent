import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { PermissionPolicyId } from '@littlesheep/types'

/** The logical LS container is the active, movable application data root. */
export type ContainerBoundary = 'inside' | 'outside' | 'unknown'
export type PermissionAction = 'read' | 'write' | 'execute' | 'unknown'

export interface PermissionBoundaryContext {
  cwd: string
  containerRoot?: string
  permissionMode?: PermissionPolicyId
  approve?: (action: string, detail?: unknown) => Promise<boolean>
  /** Set by the Harness after it has approved this exact tool invocation. */
  approvalGranted?: boolean
}

export interface ToolAccessDescriptor {
  action: PermissionAction
  boundary: ContainerBoundary
  paths: readonly string[]
  reason: string
}

export interface ToolAuthorization {
  allowed: boolean
  boundary: ContainerBoundary
  /** True when this call was approved by the policy or by a caller approval. */
  approvedByPolicy: boolean
  reason?: string
}

const READ_TOOLS = new Set([
  'read', 'glob', 'grep', 'memory_search', 'memory_deep_search',
  'memory_tree', 'session_status', 'inspect_attachment', 'use_skill',
])
const WRITE_TOOLS = new Set([
  'write', 'edit', 'write_file', 'edit_file', 'save_file',
  'write_memory', 'record_experience', 'create_skill',
])

/**
 * Describe the resource boundary of a tool call without executing it.
 * Unknown or opaque shell access is deliberately conservative: it must be
 * approved unless the runtime can establish that it stays inside the root.
 */
export function describeToolAccess(
  toolName: string,
  input: unknown,
  context: Pick<PermissionBoundaryContext, 'cwd' | 'containerRoot'>,
): ToolAccessDescriptor {
  const action = actionForTool(toolName, input)
  const record = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}

  if (toolName === 'exec' || toolName === 'terminal' || action === 'execute') {
    return describeCommandAccess(record, context)
  }

  const candidates = pathCandidates(record, action)
  if (candidates.length === 0 && isInternalTool(toolName)) {
    return {
      action,
      boundary: context.containerRoot ? 'inside' : 'unknown',
      paths: [],
      reason: 'runtime-owned LS data resource',
    }
  }

  const paths = candidates.map((candidate) => resolve(context.cwd, candidate))
  return {
    action,
    boundary: classifyPaths(paths, context.containerRoot),
    paths,
    reason: paths.length > 0 ? 'path-based resource check' : 'resource path was not identifiable',
  }
}

/** Decide whether a policy must ask the user before this resource is touched. */
export function shouldRequestPermissionApproval(
  mode: PermissionPolicyId,
  descriptor: ToolAccessDescriptor,
): boolean {
  if (mode === 'full') return false
  if (mode === 'restricted') return true
  if (descriptor.boundary !== 'inside') return true
  return descriptor.action !== 'read'
}

/**
 * Authorize a direct tool invocation. The Harness calls the same policy first,
 * but built-ins also use this helper so a route or plugin cannot bypass the
 * boundary by invoking a tool outside the normal loop.
 */
export async function authorizeToolAccess(
  toolName: string,
  input: unknown,
  context: PermissionBoundaryContext,
  options: { defaultRequiresApproval?: boolean } = {},
): Promise<ToolAuthorization> {
  const descriptor = describeToolAccess(toolName, input, context)
  // A missing container root remains an unknown boundary. Research and
  // restricted modes fail closed; confirmed full access deliberately covers
  // host resources regardless of boundary classification.
  const hasRuntimePolicy = context.permissionMode !== undefined
  const needsApproval = hasRuntimePolicy
    ? shouldRequestPermissionApproval(context.permissionMode!, descriptor)
    : options.defaultRequiresApproval === true

  if (!needsApproval) {
    return {
      allowed: true,
      boundary: descriptor.boundary,
      approvedByPolicy: context.permissionMode === 'full',
    }
  }
  if (context.approvalGranted === true) {
    return {
      allowed: true,
      boundary: descriptor.boundary,
      approvedByPolicy: true,
    }
  }
  const approved = await context.approve?.(toolName, input) ?? false
  return {
    allowed: approved,
    boundary: descriptor.boundary,
    approvedByPolicy: approved,
    reason: approved ? undefined : 'approval denied',
  }
}

function actionForTool(toolName: string, input: unknown): PermissionAction {
  if (toolName === 'exec' || toolName === 'terminal') return 'execute'
  if (WRITE_TOOLS.has(toolName)) return 'write'
  if (READ_TOOLS.has(toolName)) {
    if (toolName === 'memory_tree' && input && typeof input === 'object') {
      // Memory navigation changes only the run-scoped working set, not the
      // durable data root, so it remains a read-style operation here.
    }
    return 'read'
  }
  return 'unknown'
}

function isInternalTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName)
    || READ_TOOLS.has(toolName)
    || toolName.startsWith('memory_')
}

function pathCandidates(record: Record<string, unknown>, action: PermissionAction): string[] {
  const keys = action === 'read'
    ? ['file_path', 'path', 'root', 'cwd', 'workspace', 'workspacePath']
    : ['file_path', 'path', 'root', 'cwd', 'workspace', 'workspacePath', 'directory', 'target']
  const result: string[] = []
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) result.push(value.trim())
  }
  return [...new Set(result)]
}

function describeCommandAccess(
  record: Record<string, unknown>,
  context: Pick<PermissionBoundaryContext, 'cwd' | 'containerRoot'>,
): ToolAccessDescriptor {
  const command = typeof record.command === 'string' ? record.command.trim() : ''
  const commandCwd = typeof record.cwd === 'string' && record.cwd.trim()
    ? resolve(context.cwd, record.cwd.trim())
    : resolve(context.cwd)
  const paths = [commandCwd]
  const explicitPaths = extractCommandPaths(command)
  paths.push(...explicitPaths.map((value) => resolve(commandCwd, value)))
  const boundary = classifyPaths(paths, context.containerRoot)
  if (boundary === 'outside') {
    return { action: 'execute', boundary, paths, reason: 'command references a path outside the LS container' }
  }
  if (boundary === 'unknown') {
    return { action: 'execute', boundary, paths, reason: 'command boundary cannot be proven statically' }
  }
  if (looksOpaqueOrExternal(command)) {
    return {
      action: 'execute',
      boundary: 'unknown',
      paths,
      reason: 'command may spawn an external process or access a network resource',
    }
  }
  return { action: 'execute', boundary: 'inside', paths, reason: 'working directory and command references are inside the LS container' }
}

function extractCommandPaths(command: string): string[] {
  if (!command) return []
  const values: string[] = []
  const windows = command.match(/[A-Za-z]:[\\/][^\s"'`<>|;&()]+/gu) ?? []
  const unc = command.match(/\\\\[^\s"'`<>|;&()]+/gu) ?? []
  const unix = command.match(/(?:^|\s)(\/(?:[^\s"'`<>|;&()]+))/gu) ?? []
  const traversal = command.match(/((?:\.\.[\\/])+[^\s"'`<>|;&()]+)/gu) ?? []
  values.push(...windows, ...unc, ...unix.map((value) => value.trim()), ...traversal)
  if (/\.\.[\\/]/u.test(command)) values.push('..')
  return [...new Set(values)]
}

function looksOpaqueOrExternal(command: string): boolean {
  if (!command) return true
  if (/https?:\/\/|\\\\/iu.test(command)) return true
  if (/[;&|<>`]|\$\(|\$env:/iu.test(command)) return true
  // Shell variables, home-directory expansion and provider-qualified paths
  // cannot be bounded from the command text alone.
  if (/\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%|(?:^|\s)~(?:[\\/\s]|$)|\b(?:Env|Registry|Variable|Alias|Function|Cert):/iu.test(command)) return true
  if (/\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|Start-Process|Invoke-Expression|Start-Job|ssh|scp|docker|git\s+(?:clone|pull|push)|git\s+config\s+--global|(?:npm|pnpm|yarn)\s+(?:install|add|update)|pip\s+install|powershell|pwsh|cmd(?:\.exe)?|bash|sh)\b/iu.test(command)) {
    return true
  }

  // Interpreters can reach arbitrary host resources through code that is not
  // visible as a path in the command line. Version/help probes are harmless;
  // evaluation or script execution is opaque and must be approved.
  if (/\b(?:node|nodejs|python(?:\d+(?:\.\d+)*)?|py|ruby|perl|php|java|dotnet|wsl)\b/iu.test(command)) {
    return !/^\s*(?:node|nodejs|python(?:\d+(?:\.\d+)*)?|py|ruby|perl|php|java|dotnet|wsl)\s+(?:--version|-V|version|--help|-h)\s*$/iu.test(command)
  }
  return false
}

function classifyPaths(paths: readonly string[], containerRoot?: string): ContainerBoundary {
  if (!containerRoot) return 'unknown'
  if (paths.length === 0) return 'unknown'
  let unknown = false
  for (const path of paths) {
    const boundary = classifyPath(path, containerRoot)
    if (boundary === 'outside') return 'outside'
    if (boundary === 'unknown') unknown = true
  }
  return unknown ? 'unknown' : 'inside'
}

function classifyPath(path: string, containerRoot: string): ContainerBoundary {
  const root = canonicalPath(containerRoot)
  const candidate = canonicalPath(path)
  if (!root || !candidate) return 'unknown'
  const normalizedRoot = normalizeForComparison(root)
  const normalizedCandidate = normalizeForComparison(candidate)
  const relativePath = relative(normalizedRoot, normalizedCandidate)
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
    ? 'inside'
    : 'outside'
}

function canonicalPath(path: string): string | undefined {
  const absolute = resolve(path)
  const missing: string[] = []
  let cursor = absolute
  while (!existsSync(cursor)) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) return undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
    }
    const parent = dirname(cursor)
    if (parent === cursor) return absolute
    missing.unshift(basename(cursor))
    cursor = parent
  }
  try {
    return resolve(realpathSync.native(cursor), ...missing)
  } catch {
    return undefined
  }
}

function normalizeForComparison(value: string): string {
  return process.platform === 'win32' ? value.toLocaleLowerCase() : value
}
