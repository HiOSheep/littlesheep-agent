import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NetworkReadPolicy } from '@littlesheep/types'
import {
  authorizeToolAccess,
  describeToolAccess,
  resolvePermissionDecision,
  shouldRequestPermissionApproval,
} from './permission-boundary.js'

const roots: string[] = []

async function makeFixture(): Promise<{ containerRoot: string; cwd: string; insideFile: string; outsideFile: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'littlesheep-permission-'))
  roots.push(parent)
  const containerRoot = join(parent, 'container')
  const outsideRoot = join(parent, 'outside')
  await mkdir(join(containerRoot, 'workplace'), { recursive: true })
  await mkdir(outsideRoot, { recursive: true })
  const insideFile = join(containerRoot, 'workplace', 'inside.txt')
  const outsideFile = join(outsideRoot, 'outside.txt')
  await writeFile(insideFile, 'inside', 'utf8')
  await writeFile(outsideFile, 'outside', 'utf8')
  return { containerRoot, cwd: containerRoot, insideFile, outsideFile }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('permission boundary', () => {
  it('classifies absolute and relative paths against the movable data root', async () => {
    const fixture = await makeFixture()
    expect(describeToolAccess('read', { file_path: fixture.insideFile }, fixture).boundary).toBe('inside')
    expect(describeToolAccess('read', { file_path: fixture.outsideFile }, fixture).boundary).toBe('outside')
    expect(describeToolAccess('read', { file_path: 'workplace/inside.txt' }, {
      cwd: fixture.containerRoot,
      containerRoot: fixture.containerRoot,
    }).boundary).toBe('inside')
  })

  it('uses the strict mode matrix', async () => {
    const fixture = await makeFixture()
    const insideRead = describeToolAccess('read', { file_path: fixture.insideFile }, fixture)
    const insideWrite = describeToolAccess('write', { file_path: fixture.insideFile }, fixture)
    const insideExec = describeToolAccess('exec', { command: 'pwd', cwd: fixture.containerRoot }, fixture)
    const outsideRead = describeToolAccess('read', { file_path: fixture.outsideFile }, fixture)

    expect(shouldRequestPermissionApproval('full', insideRead)).toBe(false)
    expect(shouldRequestPermissionApproval('full', insideWrite)).toBe(false)
    expect(shouldRequestPermissionApproval('full', insideExec)).toBe(false)
    expect(shouldRequestPermissionApproval('full', outsideRead)).toBe(false)
    expect(shouldRequestPermissionApproval('full', {
      action: 'execute',
      effect: 'execute',
      egress: 'none',
      trust: 'runtime_owned',
      safeReadClass: 'none',
      hardDecision: 'approval',
      boundary: 'unknown',
      paths: [],
      reason: 'dynamic command',
    })).toBe(false)
    expect(shouldRequestPermissionApproval('research', insideRead)).toBe(false)
    expect(shouldRequestPermissionApproval('research', insideWrite)).toBe(true)
    expect(shouldRequestPermissionApproval('research', insideExec)).toBe(true)
    expect(shouldRequestPermissionApproval('research', outsideRead)).toBe(true)
    expect(shouldRequestPermissionApproval('restricted', insideRead)).toBe(true)
  })

  it('classifies document tools with the same read and write policy as filesystem tools', async () => {
    const fixture = await makeFixture()
    const documentRead = describeToolAccess('document_read', { file_path: fixture.insideFile }, fixture)
    const documentCreate = describeToolAccess('document_create', { file_path: fixture.insideFile }, fixture)

    expect(documentRead).toMatchObject({ action: 'read', boundary: 'inside' })
    expect(documentCreate).toMatchObject({ action: 'write', boundary: 'inside' })
    expect(shouldRequestPermissionApproval('research', documentRead)).toBe(false)
    expect(shouldRequestPermissionApproval('research', documentCreate)).toBe(true)
    expect(shouldRequestPermissionApproval('restricted', documentRead)).toBe(true)
  })

  it('treats explicit external command paths and dynamic shell access conservatively', async () => {
    const fixture = await makeFixture()
    const explicit = describeToolAccess('exec', {
      command: `Get-Content "${fixture.outsideFile}"`,
      cwd: fixture.containerRoot,
    }, fixture)
    const parentTraversal = describeToolAccess('exec', {
      command: 'Get-Content ..\\..\\outside\\outside.txt',
      cwd: join(fixture.containerRoot, 'workplace'),
    }, fixture)
    const dynamic = describeToolAccess('exec', {
      command: 'Get-Content $HOME\\secret.txt',
      cwd: fixture.containerRoot,
    }, fixture)

    expect(explicit.boundary).toBe('outside')
    expect(parentTraversal.boundary).toBe('outside')
    expect(dynamic.boundary).toBe('unknown')
  })

  it('treats host-side interpreter evaluation as opaque even when cwd is inside', async () => {
    const fixture = await makeFixture()
    for (const command of ['node -e process.exit(0)', 'python -c pass']) {
      expect(describeToolAccess('exec', {
        command,
        cwd: fixture.containerRoot,
      }, fixture).boundary).toBe('unknown')
    }
    expect(describeToolAccess('exec', {
      command: 'node --version',
      cwd: fixture.containerRoot,
    }, fixture).boundary).toBe('inside')
  })

  it('uses a one-call approval and denies when the callback is absent or rejects', async () => {
    const fixture = await makeFixture()
    const approve = vi.fn(async () => true)
    const context = {
      cwd: fixture.containerRoot,
      containerRoot: fixture.containerRoot,
      permissionMode: 'research' as const,
      approve,
    }
    await expect(authorizeToolAccess('write', { file_path: fixture.insideFile }, context)).resolves.toMatchObject({
      allowed: true,
      approvedByPolicy: true,
    })
    expect(approve).toHaveBeenCalledTimes(1)
    await expect(authorizeToolAccess('read', { file_path: fixture.insideFile }, {
      ...context,
      approvalGranted: true,
    })).resolves.toMatchObject({ allowed: true, approvedByPolicy: false })
    await expect(authorizeToolAccess('write', { file_path: fixture.insideFile }, {
      ...context,
      approve: async () => false,
    })).resolves.toMatchObject({ allowed: false, reason: 'approval denied' })
  })

  it('lets confirmed full access cover unknown host boundaries', async () => {
    const approve = vi.fn(async () => false)
    await expect(authorizeToolAccess('read', { file_path: 'outside.txt' }, {
      cwd: process.cwd(),
      permissionMode: 'full',
      approve,
    })).resolves.toMatchObject({
      allowed: true,
      boundary: 'unknown',
      approvedByPolicy: true,
    })
    expect(approve).not.toHaveBeenCalled()
  })

  it('keeps local memory, local session, and public web reads safe without widening ordinary reads', async () => {
    const fixture = await makeFixture()
    const policy = publicWebPolicy()
    const descriptors = [
      describeToolAccess('memory_search', { query: 'anchor' }, fixture),
      describeToolAccess('session_status', { action: 'get' }, fixture),
      describeToolAccess('web_search', { query: 'latest public information' }, { cwd: process.cwd(), networkPolicy: policy }),
      describeToolAccess('web_fetch', { url: 'https://example.com/public' }, { cwd: process.cwd(), networkPolicy: policy }),
    ]

    expect(descriptors.map((descriptor) => descriptor.safeReadClass)).toEqual([
      'local_memory',
      'local_session',
      'public_web_search',
      'public_web_fetch',
    ])
    expect(descriptors.every((descriptor) => descriptor.hardDecision === 'allow')).toBe(true)
    for (const mode of ['full', 'research', 'restricted'] as const) {
      expect(descriptors.every((descriptor) => resolvePermissionDecision(mode, descriptor) === 'allow')).toBe(true)
    }

    const ordinaryInsideRead = describeToolAccess('read', { file_path: fixture.insideFile }, fixture)
    const ordinaryOutsideRead = describeToolAccess('read', { file_path: fixture.outsideFile }, fixture)
    const write = describeToolAccess('write', { file_path: fixture.insideFile }, fixture)
    const exec = describeToolAccess('exec', { command: 'Get-ChildItem', cwd: fixture.containerRoot }, fixture)
    expect(resolvePermissionDecision('research', ordinaryInsideRead)).toBe('allow')
    expect(resolvePermissionDecision('research', ordinaryOutsideRead)).toBe('approval')
    expect(resolvePermissionDecision('restricted', ordinaryInsideRead)).toBe('approval')
    expect(resolvePermissionDecision('restricted', write)).toBe('approval')
    expect(resolvePermissionDecision('restricted', exec)).toBe('approval')
  })

  it('re-enables approval for safe reads only when strictReadApproval is enabled', () => {
    const descriptor = describeToolAccess(
      'web_search',
      { query: 'strict read' },
      { cwd: process.cwd(), networkPolicy: publicWebPolicy({ strictReadApproval: true }) },
    )
    expect(shouldRequestPermissionApproval('full', descriptor, { strictReadApproval: true })).toBe(false)
    expect(shouldRequestPermissionApproval('research', descriptor, { strictReadApproval: true })).toBe(true)
    expect(shouldRequestPermissionApproval('restricted', descriptor, { strictReadApproval: true })).toBe(true)
  })

  it('hard-denies disabled, credentialed, private, blocked, and invalid web targets', () => {
    const disabledSearch = describeToolAccess('web_search', { query: 'disabled' }, {
      cwd: process.cwd(),
      networkPolicy: publicWebPolicy({ enabled: false, mode: 'disabled' }),
    })
    const missingPolicyFetch = describeToolAccess('web_fetch', { url: 'https://example.com' }, { cwd: process.cwd() })
    const dangerousUrls = [
      'file:///C:/secret.txt',
      'https://user:password@example.com/private',
      'http://127.0.0.1:8080/admin',
      'http://169.254.169.254/latest/meta-data',
    ]
    const dangerous = dangerousUrls.map((url) => describeToolAccess(
      'web_fetch',
      { url },
      { cwd: process.cwd(), networkPolicy: publicWebPolicy() },
    ))
    const blocked = describeToolAccess(
      'web_fetch',
      { url: 'https://blocked.example.com/page' },
      { cwd: process.cwd(), networkPolicy: publicWebPolicy({ blockDomains: ['example.com'] }) },
    )
    const outsideAllowlist = describeToolAccess(
      'web_fetch',
      { url: 'https://outside.example.com/page' },
      {
        cwd: process.cwd(),
        networkPolicy: publicWebPolicy({
          mode: 'configured_allowlist',
          allowDomains: ['allowed.example.com'],
        }),
      },
    )

    expect(disabledSearch.hardDecision).toBe('deny')
    expect(missingPolicyFetch.hardDecision).toBe('deny')
    expect(dangerous.every((descriptor) => descriptor.hardDecision === 'deny')).toBe(true)
    expect(blocked.hardDecision).toBe('deny')
    expect(outsideAllowlist).toMatchObject({
      hardDecision: 'approval',
      safeReadClass: 'arbitrary_read',
    })
    for (const mode of ['full', 'research', 'restricted'] as const) {
      expect(resolvePermissionDecision(mode, disabledSearch)).toBe('deny')
      expect(resolvePermissionDecision(mode, missingPolicyFetch)).toBe('deny')
      expect(dangerous.every((descriptor) => resolvePermissionDecision(mode, descriptor) === 'deny')).toBe(true)
      expect(resolvePermissionDecision(mode, blocked)).toBe('deny')
    }
  })

  it('does not classify a session mutation as local-session safe read', async () => {
    const fixture = await makeFixture()
    const descriptor = describeToolAccess('session_status', { action: 'set', model: 'next-model' }, fixture)

    expect(descriptor).toMatchObject({
      action: 'write',
      effect: 'write',
      safeReadClass: 'none',
      trust: 'runtime_owned',
    })
    expect(resolvePermissionDecision('research', descriptor)).toBe('approval')
    expect(resolvePermissionDecision('restricted', descriptor)).toBe('approval')
    expect(resolvePermissionDecision('full', descriptor)).toBe('allow')
  })

  it('does not widen strictReadApproval beyond the safe-read exemption', async () => {
    const fixture = await makeFixture()
    const insideRead = describeToolAccess('read', { file_path: fixture.insideFile }, fixture)
    expect(resolvePermissionDecision('research', insideRead, { strictReadApproval: true })).toBe('allow')
    expect(resolvePermissionDecision('restricted', insideRead, { strictReadApproval: true })).toBe('approval')
  })
})

function publicWebPolicy(overrides: Partial<NetworkReadPolicy> = {}): NetworkReadPolicy {
  return {
    version: 1,
    enabled: true,
    providerId: 'tavily',
    mode: 'public_anonymous',
    allowDomains: [],
    blockDomains: [],
    strictReadApproval: false,
    maxResults: 10,
    maxQueryChars: 2_000,
    maxQueriesPerRun: 4,
    maxFetchesPerRun: 4,
    maxConcurrentRequests: 4,
    searchTimeoutMs: 15_000,
    fetchTimeoutMs: 20_000,
    totalTimeoutMs: 90_000,
    maxResponseBytes: 2 * 1024 * 1024,
    maxExtractedChars: 40_000,
    maxRedirects: 5,
    cacheEnabled: true,
    cacheTtlSeconds: 300,
    cacheMaxBytes: 64 * 1024 * 1024,
    browserFallback: 'approval_required',
    sensitiveQueryPolicy: 'approve',
    ...overrides,
  }
}
