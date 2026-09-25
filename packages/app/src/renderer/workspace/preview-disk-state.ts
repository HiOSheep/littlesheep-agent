// Is what the pane shows still what is on disk? (UX-25 item 3)
//
// The save path already refuses to overwrite a newer file (Main answers 409), but a
// 409 only arrives when the user tries to save. The pane has to be able to say
// "磁盘上的版本已变化" or "文件已被删除" while the user is still editing, so this module
// turns the dry facts — the version the pane loaded, the draft it holds, and what Main
// reports for the path now — into one state with one notice.
//
// Pure: no timers, no fetching. The caller decides how often to ask.

export type WorkspaceDiskState =
  /** Disk matches the version the pane loaded. */
  | 'clean'
  /** Disk changed after the pane loaded it. */
  | 'changed'
  /** The file is gone. */
  | 'deleted'
  /** No answer yet (or the check failed): say nothing rather than guess. */
  | 'unknown'

export interface WorkspaceDiskNotice {
  state: Exclude<WorkspaceDiskState, 'unknown' | 'clean'>
  tone: 'warning' | 'failure'
  message: string
  /** Only offered while a draft exists: without one there is nothing to protect. */
  actions: Array<'keepDraft' | 'reloadFromDisk'>
}

/**
 * Compare the loaded version with the current one.
 *
 * `mtimeMs` is compared exactly: a save writes a new mtime, and the pane records the
 * mtime Main returned for the version it is showing, so equality is the only safe
 * reading. A missing file is 'deleted' even without a draft — the user has to know
 * that saving would recreate it.
 */
export function workspaceDiskState(input: {
  exists: boolean
  diskModifiedAt: number | null
  loadedModifiedAt: number | undefined
}): WorkspaceDiskState {
  if (!input.exists) return 'deleted'
  if (typeof input.diskModifiedAt !== 'number') return 'unknown'
  if (typeof input.loadedModifiedAt !== 'number') return 'unknown'
  return input.diskModifiedAt === input.loadedModifiedAt ? 'clean' : 'changed'
}

/**
 * What to tell the user, and what they can do about it.
 *
 * A draft is never dropped by a notice: reloading from disk is the user's explicit
 * choice, and even then the draft survives in the session until it is saved or
 * discarded through the normal save path.
 */
export function workspaceDiskNotice(state: WorkspaceDiskState, dirty: boolean): WorkspaceDiskNotice | null {
  if (state === 'unknown' || state === 'clean') return null
  if (state === 'deleted') {
    return {
      state,
      tone: 'failure',
      message: '这个文件已不在磁盘上（可能被移动或删除）。保存会重新创建它。',
      actions: dirty ? ['keepDraft'] : [],
    }
  }
  return {
    state,
    tone: 'warning',
    message: dirty
      ? '磁盘上的版本已变化。你正在编辑的是打开时的版本，直接保存会覆盖新的内容。'
      : '磁盘上的版本已变化，预览显示的是打开时的版本。',
    actions: dirty ? ['keepDraft', 'reloadFromDisk'] : ['reloadFromDisk'],
  }
}
