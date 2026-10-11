import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { createPermissionApprover } from './run-policy.js'

describe('Main approval recheck', () => {
  it.each(['read-only', 'workspace-write', 'full-access'] as const)('does not consult the broker for mandatory approval when approval policy is deny in %s', async (preset) => {
    const broker = vi.fn(async () => true)
    const approve = createPermissionApprover(preset, broker, {
      permissionPolicyV2: {
        version: 2, preset, approvalPolicy: 'deny', workspaceRoot: process.cwd(), protectedRoots: [],
        constraints: { workspaceFileWrites: 'available', shellIsolation: 'unavailable' }, fullAccessConfirmed: true,
      },
    })
    await expect(approve('plugin_custom_action', { payload: 'opaque effect' }, {
      requiresExplicitUserApproval: true,
    })).resolves.toBe(false)
    expect(broker).not.toHaveBeenCalled()
  })

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
