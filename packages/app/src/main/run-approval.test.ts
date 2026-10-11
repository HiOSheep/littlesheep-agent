import { describe, expect, it, vi } from 'vitest'
import { createPermissionApprover } from './run-policy.js'

describe('Main approval recheck', () => {
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
