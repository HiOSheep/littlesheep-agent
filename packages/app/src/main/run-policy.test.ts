import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@littlesheep/config'
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

  it('allows full access only for proven container paths', async () => {
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
    })('exec', { command: 'pwd', cwd: '..' })).resolves.toBe(false)
    expect(broker).toHaveBeenCalledWith(expect.objectContaining({ boundary: 'outside' }))
    await expect(createPermissionApprover('research')('write')).resolves.toBe(false)
    expect(resolveRunPolicy({ permissionMode: 'restricted' }, DEFAULT_CONFIG, broker).requireApprovalForAllTools).toBe(true)
  })
})
