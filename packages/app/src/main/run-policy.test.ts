import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import type { NetworkReadPolicy } from '@littlesheep/types'
import { createPermissionApprover, resolveRunPolicy } from './run-policy.js'

describe('local app run policy', () => {
  it('keeps behavior profile and permission policy independent', async () => {
    const broker = vi.fn(async () => true)
    const policy = resolveRunPolicy({ profile: 'coding', permissionMode: 'research' }, DEFAULT_CONFIG, broker)

    expect(policy.profile).toBe('coding')
    expect(policy.permissionPolicyId).toBe('research')
    expect(policy.requireApprovalForAllTools).toBe(false)
    await expect(policy.approve('exec', { command: 'pnpm test' })).resolves.toBe(true)
    expect(broker).toHaveBeenCalledWith({
      action: 'exec',
      detail: { command: 'pnpm test' },
      permissionMode: 'research',
      boundary: 'unknown',
    })
  })

  it('migrates legacy coding to the coding profile without granting full access', async () => {
    const broker = vi.fn(async () => false)
    const policy = resolveRunPolicy({ mode: 'coding' }, DEFAULT_CONFIG, broker)

    expect(policy.profile).toBe('coding')
    expect(policy.permissionPolicyId).toBe('research')
    expect(policy.requireApprovalForAllTools).toBe(false)
    await expect(policy.approve('write', { file_path: 'README.md' })).resolves.toBe(false)
    expect(broker).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'research' }))
  })

  it('asks again for identical operations when approval is only for one call', async () => {
    const broker = vi.fn(async () => true)
    const approve = createPermissionApprover('research', broker)
    const detail = { command: 'pnpm test' }

    await approve('exec', detail)
    await approve('exec', detail)

    expect(broker).toHaveBeenCalledTimes(2)
  })

  it('allows full access for inside, outside, and unknown host boundaries', async () => {
    const broker = vi.fn(async () => false)
    const containerRoot = process.cwd()
    await expect(createPermissionApprover('full', broker, {
      containerRoot,
      cwd: containerRoot,
    })('exec', { command: 'pwd', cwd: containerRoot })).resolves.toBe(true)
    expect(broker).not.toHaveBeenCalled()
    await expect(createPermissionApprover('full', broker, {
      containerRoot,
      cwd: containerRoot,
    })('exec', { command: 'pwd', cwd: '..' })).resolves.toBe(true)
    await expect(createPermissionApprover('full', broker, {
      containerRoot,
      cwd: containerRoot,
    })('exec', { command: 'Get-Content $HOME\\secret.txt' })).resolves.toBe(true)
    expect(broker).not.toHaveBeenCalled()
    await expect(createPermissionApprover('research')('write')).resolves.toBe(false)
    expect(resolveRunPolicy({ permissionMode: 'restricted' }, DEFAULT_CONFIG, broker).requireApprovalForAllTools).toBe(true)
  })

  it('passes the resolved strict-read policy into the Main approval recheck', async () => {
    const broker = vi.fn(async () => true)
    const policy = resolveRunPolicy(
      { permissionMode: 'research' },
      DEFAULT_CONFIG,
      broker,
      { networkPolicy: webPolicy({ strictReadApproval: true }) },
    )

    await expect(policy.approve('web_search', { query: 'fresh public data' })).resolves.toBe(true)
    expect(broker).toHaveBeenCalledWith(expect.objectContaining({
      action: 'web_search',
      permissionMode: 'research',
      boundary: 'outside',
    }))
  })

  it('hard-denies disabled and private web reads in Main without consulting the broker', async () => {
    const broker = vi.fn(async () => true)
    const disabled = resolveRunPolicy({ permissionMode: 'research' }, DEFAULT_CONFIG, broker)
    await expect(disabled.approve('web_search', { query: 'must not leave host' })).resolves.toBe(false)

    const enabled = resolveRunPolicy(
      { permissionMode: 'full' },
      DEFAULT_CONFIG,
      broker,
      { networkPolicy: webPolicy() },
    )
    await expect(enabled.approve('web_fetch', { url: 'http://127.0.0.1:9/admin' })).resolves.toBe(false)
    expect(broker).not.toHaveBeenCalled()
  })
})

function webPolicy(overrides: Partial<NetworkReadPolicy> = {}): NetworkReadPolicy {
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
