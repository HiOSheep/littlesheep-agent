// UX-25 item 3: a save that lost the race must say *why*, not "try again later".
import { describe, expect, it } from 'vitest'
import { workspaceSaveErrorMessage } from './workspace-errors'

/** What the Local App API client throws: an Error that also carries the status. */
function apiError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number }
  error.status = status
  return error
}

describe('workspace save error message', () => {
  it('shows the server sentence for statuses the user can act on', () => {
    expect(workspaceSaveErrorMessage(
      apiError(409, '文件已被外部修改。请刷新预览后再保存，避免覆盖新的内容。'),
      '文件保存失败，请稍后重试。',
    )).toBe('文件已被外部修改。请刷新预览后再保存，避免覆盖新的内容。')
    expect(workspaceSaveErrorMessage(apiError(413, '文件超过 2048 KB，当前阶段不支持内置保存。'), 'fallback'))
      .toContain('不支持内置保存')
    expect(workspaceSaveErrorMessage(apiError(415, '当前阶段只支持保存文本或 Markdown 文件。'), 'fallback'))
      .toContain('只支持保存')
    expect(workspaceSaveErrorMessage(apiError(403, 'workspace save does not follow symbolic links'), 'fallback'))
      .toContain('symbolic links')
  })

  it('keeps the generic sentence for anything else', () => {
    // A transport failure or a 500 has no actionable wording; "稍后重试" is honest there.
    expect(workspaceSaveErrorMessage(apiError(500, 'boom'), '文件保存失败，请稍后重试。')).toBe('文件保存失败，请稍后重试。')
    expect(workspaceSaveErrorMessage(new Error('socket closed'), '文件保存失败，请稍后重试。')).toBe('文件保存失败，请稍后重试。')
    expect(workspaceSaveErrorMessage(apiError(409, '   '), '文件保存失败，请稍后重试。')).toBe('文件保存失败，请稍后重试。')
  })

  it('reports a vanished path as such instead of a save failure', () => {
    expect(workspaceSaveErrorMessage(apiError(404, 'ENOENT: no such file or directory'), 'fallback'))
      .toBe('文件已不存在或已被移动，请刷新文件树后重试。')
  })
})
