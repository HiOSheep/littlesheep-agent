import { describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  listWorkspaceDirectory: vi.fn(),
  openWorkspacePathInVSCode: vi.fn(),
}))

import {
  isMissingWorkspacePathError,
  missingWorkspaceFileMessage,
  workspaceErrorMessage,
} from './workspace-errors'

describe('workspace file navigator errors', () => {
  it('recognizes missing paths without requiring the OS error shape', () => {
    expect(isMissingWorkspacePathError({ code: 'ENOENT' })).toBe(true)
    expect(isMissingWorkspacePathError({
      message: "ENOENT: no such file or directory, lstat 'D:\\missing'",
    })).toBe(true)
  })

  it('does not classify unrelated failures as missing paths', () => {
    expect(isMissingWorkspacePathError(new Error('permission denied'))).toBe(false)
    expect(isMissingWorkspacePathError({ code: 'EACCES', message: 'access denied' })).toBe(false)
    expect(isMissingWorkspacePathError(null)).toBe(false)
  })

  it('silently removes missing-path details from user-facing errors', () => {
    const error = new Error("ENOENT: no such file or directory, lstat 'D:\\missing'")

    expect(workspaceErrorMessage(error, '原始错误')).toBe('')
    expect(workspaceErrorMessage(new Error('permission denied'), '通用错误')).toBe('通用错误')
    expect(isMissingWorkspacePathError(error.message)).toBe(true)
  })

  it('provides an inline file-preview message for a missing file', () => {
    const error = new Error("ENOENT: no such file or directory, stat 'C:\\missing.html'")

    expect(missingWorkspaceFileMessage(error)).toBe('文件已不存在或已被移动，请刷新文件树后重试。')
    expect(missingWorkspaceFileMessage(new Error('permission denied'))).toBe('')
  })
})
