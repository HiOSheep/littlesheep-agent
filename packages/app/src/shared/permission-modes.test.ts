import { describe, expect, it } from 'vitest'
import {
  ALL_PERMISSION_MODES,
  normalizePermissionModeId,
  resolvePermissionModePolicy,
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
})
