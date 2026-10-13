// Central path, network, safe-read, and hard-deny authorization descriptor.
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  ApprovalPolicyId,
  NetworkReadPolicy,
  PermissionConstraintAvailability,
  PermissionPolicyId,
  PermissionPolicyV2Snapshot,
  PermissionPresetId,
} from '@littlesheep/types'

/** The logical LS container is the active, movable application data root. */
export type ContainerBoundary = 'inside' | 'outside' | 'unknown'
export type PermissionAction = 'read' | 'write' | 'execute' | 'unknown'
export type PermissionEffect = 'none' | 'read' | 'write' | 'execute' | 'external'
export type PermissionEgress = 'none' | 'public_query' | 'public_url' | 'authenticated' | 'unknown'
export type PermissionTrust = 'runtime_owned' | 'external_untrusted'
export type PermissionResourceScope = 'workspace' | 'data_root' | 'protected' | 'outside' | 'unknown' | 'runtime' | 'external'
export type SafeReadClass =
  | 'local_memory'
  | 'local_session'
  | 'public_web_search'
  | 'public_web_fetch'
  | 'authenticated_read'
  | 'arbitrary_read'
  | 'none'
export type HardDecision = 'allow' | 'approval' | 'deny' | 'unavailable'
export type PermissionDecision = 'allow' | 'approval' | 'deny' | 'unavailable'
export type PermissionPolicySelection = PermissionPolicyId | PermissionPresetId

export interface PermissionBoundaryContext {
  cwd: string
  containerRoot?: string
  dataRoot?: string
  workspaceRoot?: string
  protectedRoots?: readonly string[]
  protectedWriteRoots?: readonly string[]
  permissionMode?: PermissionPolicyId
  permissionPreset?: PermissionPresetId
  approvalPolicy?: ApprovalPolicyId
  workspaceFileWrites?: PermissionConstraintAvailability
  shellIsolation?: PermissionConstraintAvailability
  fullAccessConfirmed?: boolean
  /** Main-owned versioned snapshot. Its roots and capabilities are immutable for the run. */
  permissionPolicyV2?: PermissionPolicyV2Snapshot
  approve?: (
    action: string,
    detail?: unknown,
    options?: { requiresExplicitUserApproval?: boolean },
  ) => Promise<boolean>
  /** Immutable network policy resolved before this run. */
  networkPolicy?: Readonly<NetworkReadPolicy>
}

export interface ToolAccessDescriptor {
  action: PermissionAction
  effect: PermissionEffect
  egress: PermissionEgress
  trust: PermissionTrust
  safeReadClass: SafeReadClass
  hardDecision: HardDecision
  resourceScope?: PermissionResourceScope
  boundary: ContainerBoundary
  paths: readonly string[]
  urls?: readonly string[]
  reason: string
}

type PartialToolAccessDescriptor = Omit<
  ToolAccessDescriptor,
  'effect' | 'egress' | 'trust' | 'safeReadClass' | 'hardDecision' | 'resourceScope'
> & Partial<Pick<ToolAccessDescriptor, 'effect' | 'egress' | 'trust' | 'safeReadClass' | 'hardDecision' | 'resourceScope'>>

export interface ToolAuthorization {
  allowed: boolean
  decision: PermissionDecision
  boundary: ContainerBoundary
  /** True when this call was approved by the policy or by a caller approval. */
  approvedByPolicy: boolean
  reason?: string
}

const READ_TOOLS = new Set([
  'read', 'glob', 'grep', 'memory_search', 'memory_deep_search',
  'memory_tree', 'session_status', 'inspect_attachment', 'use_skill', 'document_read',
])
const LOCAL_MEMORY_TOOLS = new Set([
  'memory_search', 'memory_deep_search', 'memory_tree',
])
const LOCAL_SESSION_TOOLS = new Set([
  'session_status',
])
const WRITE_TOOLS = new Set([
  'write', 'edit', 'write_file', 'edit_file', 'save_file',
  'write_memory', 'record_experience', 'document_create',
])

/**
 * Describe the resource boundary of a tool call without executing it.
 * Unknown or opaque shell access is deliberately conservative: it must be
 * approved unless the runtime can establish that it stays inside the root.
 */
export function describeToolAccess(
  toolName: string,
  input: unknown,
  context: Pick<PermissionBoundaryContext,
    'cwd' | 'containerRoot' | 'dataRoot' | 'workspaceRoot' | 'protectedRoots' | 'protectedWriteRoots' | 'permissionPolicyV2' | 'networkPolicy'>,
): ToolAccessDescriptor {
  const finish = (descriptor: PartialToolAccessDescriptor): ToolAccessDescriptor => {
    const normalized = withDescriptorDefaults(descriptor)
    return applyResourceClassification(normalized, context)
  }
  const action = actionForTool(toolName, input)
  const record = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}

  if (toolName === 'exec' || toolName === 'terminal' || action === 'execute') {
    return finish(describeCommandAccess(record, context))
  }

  if (toolName === 'web_search' || toolName === 'web_fetch') {
    return finish(describeWebAccess(toolName, record, context))
  }

  if (toolName === 'session_status' && record.action === 'set') {
    return finish({
      action: 'write',
      effect: 'write',
      egress: 'none',
      trust: 'runtime_owned',
      safeReadClass: 'none',
      hardDecision: 'allow',
      boundary: context.containerRoot ? 'inside' : 'unknown',
      paths: [],
      reason: 'runtime-owned local session mutation',
    })
  }

  if (LOCAL_MEMORY_TOOLS.has(toolName) || LOCAL_SESSION_TOOLS.has(toolName)) {
    return finish({
      action: 'read',
      effect: 'read',
      egress: 'none',
      trust: 'runtime_owned',
      safeReadClass: LOCAL_MEMORY_TOOLS.has(toolName) ? 'local_memory' : 'local_session',
      hardDecision: 'allow',
      boundary: context.containerRoot ? 'inside' : 'unknown',
      paths: [],
      reason: LOCAL_MEMORY_TOOLS.has(toolName)
        ? 'runtime-owned local memory resource'
        : 'runtime-owned local session resource',
    })
  }

  const candidates = pathCandidates(record, action)
  if (candidates.length === 0 && isInternalTool(toolName)) {
    return finish({
      action,
      boundary: context.containerRoot ? 'inside' : 'unknown',
      paths: [],
      reason: 'runtime-owned LS data resource',
    })
  }

  const paths = candidates.map((candidate) => resolve(context.cwd, candidate))
  return finish({
    action,
    boundary: classifyPaths(paths, context.containerRoot),
    paths,
    reason: paths.length > 0 ? 'path-based resource check' : 'resource path was not identifiable',
  })
}

/** Decide whether a policy must ask the user before this resource is touched. */
export function shouldRequestPermissionApproval(
  mode: PermissionPolicySelection,
  descriptor: ToolAccessDescriptor,
  options: {
    strictReadApproval?: boolean
    approvalPolicy?: ApprovalPolicyId
    workspaceFileWrites?: PermissionConstraintAvailability
    shellIsolation?: PermissionConstraintAvailability
    fullAccessConfirmed?: boolean
  } = {},
): boolean {
  return resolvePermissionDecision(mode, descriptor, options) === 'approval'
}

/**
 * Resolve the complete Runtime decision without collapsing hard deny and
 * automatic allow into the same boolean. Every caller that can execute a tool
 * must handle `deny` before considering approval.
 */
export function resolvePermissionDecision(
  mode: PermissionPolicySelection,
  descriptor: ToolAccessDescriptor,
  options: {
    strictReadApproval?: boolean
    approvalPolicy?: ApprovalPolicyId
    workspaceFileWrites?: PermissionConstraintAvailability
    shellIsolation?: PermissionConstraintAvailability
    fullAccessConfirmed?: boolean
  } = {},
): PermissionDecision {
  if (descriptor.hardDecision === 'deny') return 'deny'
  if (descriptor.hardDecision === 'unavailable') return 'unavailable'
  // A hard approval is a Main-owned requirement. No permission preset may
  // convert it into automatic execution.
  if (descriptor.hardDecision === 'approval') return 'approval'
  if (isPermissionPreset(mode)) return resolvePresetDecision(mode, descriptor, options)
  if (mode === 'full') return 'allow'
  const isSafeRead = descriptor.safeReadClass === 'local_memory'
    || descriptor.safeReadClass === 'local_session'
    || descriptor.safeReadClass === 'public_web_search'
    || descriptor.safeReadClass === 'public_web_fetch'
  if (options.strictReadApproval && isSafeRead) return 'approval'
  if (isSafeRead) return 'allow'
  if (mode === 'restricted') return 'approval'
  if (descriptor.boundary !== 'inside') return 'approval'
  return descriptor.action !== 'read' ? 'approval' : 'allow'
}

/**
 * Resolve the V2 access preset using Main-classified resource roots and the
 * enforcement capabilities that are actually active for this run.
 */
function resolvePresetDecision(
  preset: PermissionPresetId,
  descriptor: ToolAccessDescriptor,
  options: {
    approvalPolicy?: ApprovalPolicyId
    workspaceFileWrites?: PermissionConstraintAvailability
    shellIsolation?: PermissionConstraintAvailability
    fullAccessConfirmed?: boolean
  },
): PermissionDecision {
  const scope = descriptor.resourceScope ?? 'unknown'
  const askOrDeny = (): PermissionDecision => options.approvalPolicy === 'deny' ? 'deny' : 'approval'

  if (scope === 'protected' && descriptor.action !== 'read') return 'deny'

  if (preset === 'read-only') {
    return descriptor.action === 'read' && scope === 'workspace' ? 'allow' : askOrDeny()
  }

  if (preset === 'workspace-write') {
    if (descriptor.action === 'read' && scope === 'workspace') return 'allow'
    if (descriptor.action === 'write' && scope === 'workspace') {
      // Without the reliable file guard, fall back to a per-operation decision;
      // the preset must not turn an app path heuristic into automatic writing.
      return options.workspaceFileWrites === 'available' ? 'allow' : askOrDeny()
    }
    if (descriptor.action === 'execute' && scope === 'workspace') {
      // Shell commands remain individually approvable until a real OS isolation
      // layer is active. P1 never turns a path heuristic into shell confinement.
      return options.shellIsolation === 'available' ? 'allow' : askOrDeny()
    }
    return askOrDeny()
  }

  // Full local access is an explicit user choice. Even after that confirmation,
  // opaque shell execution remains per-call until OS isolation is active.
  if (options.fullAccessConfirmed !== true) return 'unavailable'
  if (descriptor.action === 'execute' && options.shellIsolation !== 'available') return askOrDeny()
  return 'allow'
}

function isPermissionPreset(value: PermissionPolicySelection): value is PermissionPresetId {
  return value === 'read-only' || value === 'workspace-write' || value === 'full-access'
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
  options: {
    defaultRequiresApproval?: boolean
    /** True only after the native reader has inspected and revalidated its path. */
    workspaceFileReadGuard?: boolean
    /** True only for native file tools that execute the workspace path guard. */
    workspaceFileWriteGuard?: boolean
    /** Convert an otherwise automatic decision into the same user-approval path. */
    forceApproval?: boolean
  } = {},
): Promise<ToolAuthorization> {
  const descriptor = describeToolAccess(toolName, input, context)
  if (descriptor.hardDecision === 'deny') {
    return {
      allowed: false,
      decision: 'deny',
      boundary: descriptor.boundary,
      approvedByPolicy: false,
      reason: descriptor.reason,
    }
  }
  if (descriptor.hardDecision === 'unavailable') {
    return {
      allowed: false,
      decision: 'unavailable',
      boundary: descriptor.boundary,
      approvedByPolicy: false,
      reason: descriptor.reason,
    }
  }
  // A missing container root remains an unknown boundary. Research and
  // restricted modes fail closed; confirmed full access deliberately covers
  // host resources regardless of boundary classification.
  const hasRuntimePolicy = context.permissionMode !== undefined
    || context.permissionPreset !== undefined
    || context.permissionPolicyV2 !== undefined
  const snapshot = context.permissionPolicyV2
  const selectedPolicy: PermissionPolicySelection | undefined = snapshot?.preset ?? context.permissionPreset ?? context.permissionMode
  const guardedWorkspaceRead = options.workspaceFileReadGuard === true
  const decision: PermissionDecision = hasRuntimePolicy
    ? resolvePermissionDecision(selectedPolicy!, descriptor, {
        strictReadApproval: context.networkPolicy?.strictReadApproval === true,
        approvalPolicy: snapshot?.approvalPolicy ?? context.approvalPolicy,
        workspaceFileWrites: options.workspaceFileWriteGuard === true
          ? snapshot?.constraints.workspaceFileWrites ?? context.workspaceFileWrites
          : 'unavailable',
        shellIsolation: snapshot?.constraints.shellIsolation ?? context.shellIsolation,
        fullAccessConfirmed: snapshot?.fullAccessConfirmed ?? context.fullAccessConfirmed,
      })
    : descriptor.hardDecision === 'approval'
      ? 'approval'
      : options.defaultRequiresApproval === true ? 'approval' : 'allow'
  const unguardedV2WorkspaceRead = snapshot !== undefined
    && (snapshot.preset === 'read-only' || snapshot.preset === 'workspace-write')
    && descriptor.action === 'read'
    && descriptor.resourceScope === 'workspace'
    && !guardedWorkspaceRead
  const forcedApproval = (options.forceApproval === true || unguardedV2WorkspaceRead)
    && decision === 'allow'
  const effectiveDecision = forcedApproval
    ? snapshot?.approvalPolicy === 'deny' || context.approvalPolicy === 'deny' ? 'deny' : 'approval'
    : decision

  if (effectiveDecision === 'deny' || effectiveDecision === 'unavailable') {
    return {
      allowed: false,
      decision: effectiveDecision,
      boundary: descriptor.boundary,
      approvedByPolicy: false,
      reason: effectiveDecision === 'unavailable' ? 'required permission enforcement is unavailable' : descriptor.reason,
    }
  }

  const needsApproval = effectiveDecision === 'approval'

  if (!needsApproval) {
    return {
      allowed: true,
      decision: 'allow',
      boundary: descriptor.boundary,
      approvedByPolicy: selectedPolicy === 'full'
        || (selectedPolicy === 'full-access' && (snapshot?.fullAccessConfirmed ?? context.fullAccessConfirmed) === true),
    }
  }
  const approved = await context.approve?.(toolName, input, {
    requiresExplicitUserApproval: true,
  }) ?? false
  return {
    allowed: approved,
    decision: 'approval',
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

function describeWebAccess(
  toolName: string,
  record: Record<string, unknown>,
  context: Pick<PermissionBoundaryContext, 'networkPolicy'>,
): ToolAccessDescriptor {
  const policy = context.networkPolicy
  const enabled = policy?.enabled === true && policy.mode !== 'disabled'
  if (!enabled) {
    return {
      action: 'read',
      effect: 'external',
      egress: toolName === 'web_search' ? 'public_query' : 'public_url',
      trust: 'external_untrusted',
      safeReadClass: toolName === 'web_search' ? 'public_web_search' : 'public_web_fetch',
      hardDecision: 'deny',
      boundary: 'outside',
      paths: [],
      urls: typeof record.url === 'string' ? [record.url] : [],
      reason: 'public network retrieval is disabled by the resolved runtime policy',
    }
  }

  if (toolName === 'web_search') {
    const rawQuery = typeof record.query === 'string' ? record.query.trim() : ''
    const projectedQuery = typeof record.queryHash === 'string' && /^[a-f0-9]{64}$/u.test(record.queryHash)
    if (!rawQuery && !projectedQuery) {
      return {
        action: 'read',
        effect: 'external',
        egress: 'public_query',
        trust: 'external_untrusted',
        safeReadClass: 'none',
        hardDecision: 'deny',
        boundary: 'outside',
        paths: [],
        reason: 'web_search requires a bounded query',
      }
    }
    const sensitive = record.sensitiveQuery === true || classifySensitiveWebQuery(rawQuery).sensitive
    if (sensitive && policy.sensitiveQueryPolicy === 'deny') {
      return {
        action: 'read', effect: 'external', egress: 'public_query', trust: 'external_untrusted',
        safeReadClass: 'none', hardDecision: 'deny', boundary: 'outside', paths: [],
        reason: 'sensitive web query egress is blocked by policy',
      }
    }
    if (sensitive && policy.sensitiveQueryPolicy === 'approve') {
      return {
        action: 'read', effect: 'external', egress: 'public_query', trust: 'external_untrusted',
        safeReadClass: 'none', hardDecision: 'approval', boundary: 'outside', paths: [],
        reason: 'sensitive web query requires explicit egress approval',
      }
    }
    return {
      action: 'read',
      effect: 'external',
      egress: 'public_query',
      trust: 'external_untrusted',
      safeReadClass: 'public_web_search',
      hardDecision: 'allow',
      boundary: 'outside',
      paths: [],
      reason: 'bounded query sent to the configured public search provider',
    }
  }

  const rawUrl = typeof record.url === 'string' ? record.url.trim() : ''
  const urlDecision = classifyPublicUrlSyntax(rawUrl, policy)
  return {
    action: 'read',
    effect: 'external',
    egress: urlDecision.egress,
    trust: 'external_untrusted',
    safeReadClass: urlDecision.safeReadClass,
    hardDecision: urlDecision.hardDecision,
    boundary: 'outside',
    paths: [],
    urls: rawUrl ? [rawUrl] : [],
    reason: urlDecision.reason,
  }
}

export interface SensitiveWebQueryClassification {
  readonly sensitive: boolean
  readonly categories: readonly ('credential' | 'cookie' | 'local_path')[]
}

export function classifySensitiveWebQuery(query: string): SensitiveWebQueryClassification {
  const categories: SensitiveWebQueryClassification['categories'][number][] = []
  if (/\bBearer\s+\S+|\b(?:api[_-]?key|access[_-]?token|authorization|password|passwd|secret)\s*[:=]\s*\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b(?:sk|tvly)-[A-Za-z0-9_-]{8,}\b/iu.test(query)) {
    categories.push('credential')
  }
  if (/\b(?:cookie|set-cookie|session(?:id|_id)?)\s*[:=]\s*\S+/iu.test(query)) categories.push('cookie')
  if (/(?:^|\s)(?:[A-Za-z]:\\|\\\\|\/(?:Users|home|etc|var|tmp|opt|srv|mnt|data)\/)[^\s"']+/u.test(query)) categories.push('local_path')
  return { sensitive: categories.length > 0, categories }
}

export function redactSensitiveWebQuery(query: string): string {
  return query
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|authorization|password|passwd|secret|cookie|set-cookie|session(?:id|_id)?)\s*[:=]\s*\S+/giu, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[REDACTED]')
    .replace(/\b(?:sk|tvly)-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]')
    .replace(/(?:^|\s)(?:[A-Za-z]:\\|\\\\|\/(?:Users|home|etc|var|tmp|opt|srv|mnt|data)\/)[^\s"']+/gu, ' [REDACTED_PATH]')
    .replace(/\s+/gu, ' ')
    .trim()
}

function classifyPublicUrlSyntax(
  rawUrl: string,
  policy: Readonly<NetworkReadPolicy>,
): Pick<ToolAccessDescriptor, 'egress' | 'safeReadClass' | 'hardDecision' | 'reason'> {
  if (!rawUrl) {
    return {
      egress: 'unknown',
      safeReadClass: 'arbitrary_read',
      hardDecision: 'deny',
      reason: 'web_fetch requires a URL',
    }
  }
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return {
      egress: 'unknown',
      safeReadClass: 'arbitrary_read',
      hardDecision: 'deny',
      reason: 'web_fetch URL is invalid',
    }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      egress: 'unknown',
      safeReadClass: 'arbitrary_read',
      hardDecision: 'deny',
      reason: `web_fetch scheme is blocked: ${parsed.protocol}`,
    }
  }
  if (parsed.username || parsed.password) {
    return {
      egress: 'authenticated',
      safeReadClass: 'authenticated_read',
      hardDecision: 'deny',
      reason: 'web_fetch URL credentials are blocked',
    }
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  if (isObviouslyPrivateHost(hostname)) {
    return {
      egress: 'unknown',
      safeReadClass: 'authenticated_read',
      hardDecision: 'deny',
      reason: 'web_fetch target is a loopback, private, link-local, metadata, or reserved address',
    }
  }
  if (matchesDomain(hostname, policy.blockDomains)) {
    return {
      egress: 'public_url',
      safeReadClass: 'arbitrary_read',
      hardDecision: 'deny',
      reason: 'web_fetch target is blocked by the network domain policy',
    }
  }
  if (policy.mode === 'configured_allowlist' && !matchesDomain(hostname, policy.allowDomains)) {
    return {
      egress: 'public_url',
      safeReadClass: 'arbitrary_read',
      hardDecision: 'approval',
      reason: 'web_fetch target is outside the configured public domain allowlist',
    }
  }
  return {
    egress: 'public_url',
    safeReadClass: 'public_web_fetch',
    hardDecision: 'allow',
    reason: 'anonymous public HTTPS/HTTP fetch candidate; DNS and redirect checks remain mandatory',
  }
}

function withDescriptorDefaults(
  descriptor: PartialToolAccessDescriptor,
): ToolAccessDescriptor {
  const action = descriptor.action
  return {
    ...descriptor,
    effect: descriptor.effect ?? (action === 'unknown' ? 'none' : action),
    egress: descriptor.egress ?? 'none',
    trust: descriptor.trust ?? 'runtime_owned',
    safeReadClass: descriptor.safeReadClass ?? (action === 'read' ? 'arbitrary_read' : 'none'),
    hardDecision: descriptor.hardDecision ?? (action === 'unknown' ? 'approval' : 'allow'),
    resourceScope: descriptor.resourceScope ?? 'unknown',
  }
}

function applyResourceClassification(
  descriptor: ToolAccessDescriptor,
  context: Pick<PermissionBoundaryContext,
    'containerRoot' | 'dataRoot' | 'workspaceRoot' | 'protectedRoots' | 'protectedWriteRoots' | 'permissionPolicyV2'>,
): ToolAccessDescriptor {
  const snapshot = context.permissionPolicyV2
  const resourceScope = classifyPermissionResourceScope(descriptor.paths, {
    dataRoot: snapshot?.dataRoot ?? context.dataRoot ?? context.containerRoot,
    workspaceRoot: snapshot?.workspaceRoot ?? context.workspaceRoot,
    protectedRoots: snapshot?.protectedRoots ?? context.protectedRoots ?? context.protectedWriteRoots,
    safeReadClass: descriptor.safeReadClass,
  })
  if (descriptor.egress !== 'none') return { ...descriptor, resourceScope: 'external' }
  // A Shell command with a dynamic or otherwise unprovable target remains
  // unknown even when its working directory is inside the workspace.
  const effectiveScope = descriptor.action === 'execute' && descriptor.boundary === 'unknown'
    ? 'unknown'
    : resourceScope
  if (
    effectiveScope === 'protected'
    && (descriptor.action === 'write' || descriptor.action === 'unknown')
    && descriptor.hardDecision !== 'deny'
  ) {
    return {
      ...descriptor,
      resourceScope: effectiveScope,
      hardDecision: 'deny',
      reason: 'tool input targets a protected resource that must remain read-only',
    }
  }
  return { ...descriptor, resourceScope: effectiveScope }
}

/** Classify paths against distinct Main-owned resource roots. */
export function classifyPermissionResourceScope(
  paths: readonly string[],
  roots: {
    dataRoot?: string
    workspaceRoot?: string
    protectedRoots?: readonly string[]
    safeReadClass?: SafeReadClass
  },
): PermissionResourceScope {
  if (paths.length === 0) {
    return roots.safeReadClass === 'local_memory' || roots.safeReadClass === 'local_session'
      ? 'runtime'
      : 'unknown'
  }

  const protectedRoots = roots.protectedRoots ?? []
  for (const path of paths) {
    for (const root of protectedRoots) {
      const boundary = classifyPath(path, root)
      if (boundary === 'inside') return 'protected'
      if (boundary === 'unknown') return 'unknown'
    }
  }

  const workspaceBoundary = classifyAllPaths(paths, roots.workspaceRoot)
  if (workspaceBoundary === 'inside') return 'workspace'
  const dataBoundary = classifyAllPaths(paths, roots.dataRoot)
  if (dataBoundary === 'inside') return 'data_root'
  if (workspaceBoundary === 'unknown' || dataBoundary === 'unknown') return 'unknown'
  return roots.workspaceRoot || roots.dataRoot ? 'outside' : 'unknown'
}

function classifyAllPaths(paths: readonly string[], root?: string): ContainerBoundary {
  if (!root) return 'unknown'
  let unknown = false
  for (const path of paths) {
    const boundary = classifyPath(path, root)
    if (boundary === 'outside') return 'outside'
    if (boundary === 'unknown') unknown = true
  }
  return unknown ? 'unknown' : 'inside'
}

function matchesDomain(hostname: string, domains: readonly string[]): boolean {
  return domains.some((domain) => {
    const normalized = domain.trim().toLowerCase().replace(/^\.+/u, '')
    return normalized.length > 0 && (hostname === normalized || hostname.endsWith(`.${normalized}`))
  })
}

function isObviouslyPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\.+/u, '')
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local')) return true
  if (/^(?:0|127)\./u.test(lower) || /^10\./u.test(lower) || /^169\.254\./u.test(lower) || /^192\.168\./u.test(lower)) return true
  const ipv4 = lower.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/u)
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number)
    const value = octets[0]! * 256 ** 3 + octets[1]! * 256 ** 2 + octets[2]! * 256 + octets[3]!
    return (octets[0]! === 172 && octets[1]! >= 16 && octets[1]! <= 31)
      || (octets[0]! === 100 && octets[1]! >= 64 && octets[1]! <= 127)
      || (octets[0]! === 192 && octets[1]! === 0)
      || (octets[0]! === 198 && octets[1]! >= 18 && octets[1]! <= 19)
      || (octets[0]! === 198 && octets[1]! === 51 && octets[2] === 100)
      || (octets[0]! === 203 && octets[1]! === 0 && octets[2] === 113)
      || octets[0]! >= 224
      || value === 0
  }
  if (lower.includes(':')) {
    const normalized = lower.replace(/^\[|\]$/gu, '')
    return normalized === '::' || normalized === '::1'
      || normalized.startsWith('fc') || normalized.startsWith('fd')
      || normalized.startsWith('fe8') || normalized.startsWith('fe9')
      || normalized.startsWith('fea') || normalized.startsWith('feb')
      || normalized.startsWith('ff') || normalized.startsWith('2001:db8:')
      || normalized.startsWith('::ffff:127.') || normalized.startsWith('::ffff:10.')
      || normalized.startsWith('::ffff:192.168.') || normalized.startsWith('::ffff:169.254.')
  }
  return false
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
): PartialToolAccessDescriptor {
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
  // Paths quoted for POSIX shells are still explicit resources. Include the
  // quote as a valid boundary so `/tmp/file` is found in `cat "/tmp/file"`.
  const unix = command.match(/(?:^|[\s"'`])(\/(?:[^\s"'`<>|;&()]+))/gu) ?? []
  const traversal = command.match(/((?:\.\.[\\/])+[^\s"'`<>|;&()]+)/gu) ?? []
  values.push(...windows, ...unc, ...unix.map((value) => value.replace(/^[\s"'`]+/u, '')), ...traversal)
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
