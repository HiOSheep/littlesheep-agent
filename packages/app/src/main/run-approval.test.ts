import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { createPermissionApprover } from './run-policy.js'

describe('Main approval recheck', () => {
  it.each(['full', 'workspace-write'] as const)('preserves service-required approval for an otherwise allowed native read in %s', async (selection) => {
    const broker = vi.fn(async () => false)
    const approve = createPermissionApprover(selection, broker, { workspaceRoot: process.cwd() })
    await expect(approve('read', { file_path: resolve('README.md') }, {
      requiresExplicitUserApproval: true,
    })).resolves.toBe(false)
    expect(broker).toHaveBeenCalledOnce()
    expect(broker).toHaveBeenCalledWith(expect.objectContaining({
      action: 'read', requiresExplicitUserApproval: true,
    }))
  })

  it('does not convert a service-required approval into automatic workspace-write', async () => {
    const broker = vi.fn(async () => false)
    const approve = createPermissionApprover('full', broker)

    await expect(approve(
      'plugin_custom_action',
      { payload: 'change something' },
      { requiresExplicitUserApproval: true },
    )).resolves.toBe(false)
    expect(broker).toHaveBeenCalledWith(expect.objectContaining({
      action: 'plugin_custom_action',
      permissionMode: 'full',
      requiresExplicitUserApproval: true,
    }))
  })
})
