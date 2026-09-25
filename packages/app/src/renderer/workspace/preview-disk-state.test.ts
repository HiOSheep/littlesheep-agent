import { describe, expect, it } from 'vitest'
import { workspaceDiskNotice, workspaceDiskState } from './preview-disk-state'

describe('workspace preview disk state', () => {
  it('separates the loaded version from the current one', () => {
    // Exactly equal mtimes mean "the pane is showing what is on disk"; a save returns
    // the new mtime, so anything else is a change.
    expect(workspaceDiskState({ exists: true, diskModifiedAt: 1_700_000_000_000, loadedModifiedAt: 1_700_000_000_000 })).toBe('clean')
    expect(workspaceDiskState({ exists: true, diskModifiedAt: 1_700_000_001_000, loadedModifiedAt: 1_700_000_000_000 })).toBe('changed')
    expect(workspaceDiskState({ exists: false, diskModifiedAt: null, loadedModifiedAt: 1_700_000_000_000 })).toBe('deleted')
  })

  it('says nothing when it cannot tell', () => {
    expect(workspaceDiskState({ exists: true, diskModifiedAt: null, loadedModifiedAt: 1 })).toBe('unknown')
    expect(workspaceDiskState({ exists: true, diskModifiedAt: 2, loadedModifiedAt: undefined })).toBe('unknown')
    expect(workspaceDiskNotice('unknown', true)).toBeNull()
    expect(workspaceDiskNotice('clean', true)).toBeNull()
  })

  it('warns while editing and never drops the draft', () => {
    const dirty = workspaceDiskNotice('changed', true)
    expect(dirty?.tone).toBe('warning')
    expect(dirty?.message).toContain('磁盘上的版本已变化')
    expect(dirty?.actions).toEqual(['keepDraft', 'reloadFromDisk'])

    const clean = workspaceDiskNotice('changed', false)
    expect(clean?.message).toContain('预览显示的是打开时的版本')
    expect(clean?.actions).toEqual(['reloadFromDisk'])
  })

  it('reports a deletion as a failure and offers no reload', () => {
    const notice = workspaceDiskNotice('deleted', true)
    expect(notice?.tone).toBe('failure')
    expect(notice?.message).toContain('已不在磁盘上')
    expect(notice?.actions).toEqual(['keepDraft'])
    // Without a draft there is nothing to keep; saving is what would recreate it.
    expect(workspaceDiskNotice('deleted', false)?.actions).toEqual([])
  })
})
