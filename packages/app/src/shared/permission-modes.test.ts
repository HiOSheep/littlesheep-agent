import { describe, expect, it } from 'vitest'
import {
  ALL_PERMISSION_MODES,
  PERMISSION_PRESETS_V2,
  normalizePermissionModeId,
  normalizePermissionSelectionId,
  resolvePermissionModePolicy,
  resolveFutureDefaultPermissionPreset,
} from './permission-modes.js'

describe('permission modes', () => {
  it('contain tool policy only and do not carry behavior prompts or timeouts', () => {
    for (const mode of ALL_PERMISSION_MODES) {
      expect(mode).not.toHaveProperty('systemPromptAddon')
      expect(mode).not.toHaveProperty('runTimeoutMs')
    }
  })

  it('migrates legacy ids without reintroducing coding as a permission mode', () => {
    expect(normalizePermissionModeId('coding')).toBe('research')
    expect(normalizePermissionModeId('full-access')).toBe('full')
    expect(normalizePermissionModeId('info')).toBe('full')
    expect(normalizePermissionModeId('physical')).toBe('restricted')
  })

  it('changes only approval policy across full, research, and restricted', () => {
    expect(resolvePermissionModePolicy('full')).toEqual({
      mode: 'full', autoApprove: true, requireApprovalForAllTools: false,
    })
    expect(resolvePermissionModePolicy('research')).toEqual({
      mode: 'research', autoApprove: false, requireApprovalForAllTools: false,
    })
    expect(resolvePermissionModePolicy('restricted')).toEqual({
      mode: 'restricted', autoApprove: false, requireApprovalForAllTools: true,
    })
  })

  it('describes full access as host-wide after explicit confirmation', () => {
    const full = ALL_PERMISSION_MODES.find((mode) => mode.id === 'full')
    expect(full?.description).toContain('容器内外')
    expect(full?.description).toContain('不再逐次请求批准')
  })

  it('keeps the three V2 access presets separate from legacy ids and gates the future default', () => {
    expect(PERMISSION_PRESETS_V2.map((preset) => preset.id)).toEqual([
      'read-only', 'workspace-write', 'full-access',
    ])
    expect(resolveFutureDefaultPermissionPreset({ workspaceFileWrites: 'unavailable' })).toBeUndefined()
    expect(resolveFutureDefaultPermissionPreset({ workspaceFileWrites: 'available' })).toBe('workspace-write')
    // V2 identifiers travel in a separate `preset` field; old mode migration
    // stays unchanged for sessions and checkpoints that store `mode`.
    expect(normalizePermissionModeId('workspace-write')).toBe('research')
    expect(normalizePermissionModeId('read-only')).toBe('research')
  })

  it('keeps public session selections in the V2 preset set and downgrades legacy ids', () => {
    expect(normalizePermissionSelectionId('workspace-write')).toBe('workspace-write')
    expect(normalizePermissionSelectionId('read-only')).toBe('read-only')
    expect(normalizePermissionSelectionId('full-access')).toBe('full-access')
    expect(normalizePermissionSelectionId('full')).toBe('read-only')
    expect(normalizePermissionSelectionId('research')).toBe('read-only')
    expect(normalizePermissionSelectionId('restricted')).toBe('read-only')
    expect(normalizePermissionSelectionId('unknown')).toBe('read-only')
  })
})
