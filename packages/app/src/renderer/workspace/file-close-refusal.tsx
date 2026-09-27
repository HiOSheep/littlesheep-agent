// The third answer to closing a dirty workspace file tab (audit P1 #9).
//
// Clicking ✕ on a dirty file raises the *permission* prompt ("允许保存工作区文件？"),
// and all three of its answers speak about permission to write. Denying it therefore
// left the tab open and dirty with nothing said, and no surface anywhere offered to
// drop the draft — the user could save or stay stuck. This module keeps the permission
// contract untouched and adds the answer it cannot express, exactly where the ✕ was
// pressed: a one-line notice on the tab strip with 放弃修改 / 继续编辑.
//
// The discard action goes back through the same close handler as `{ discardDraft: true }`,
// so the tab and its draft leave the session layout together and nothing is written.
import { useEffect, useState, type ComponentProps } from 'react'
import {
  workspaceFileCloseRefusal,
  type WorkspaceFileCloseRefusal,
  type WorkspaceFileTabCloseHandler,
} from './file-close'
import { WorkspaceTabStrip } from './tab-strip'

export type { WorkspaceFileTabCloseHandler }

export function WorkspaceFileCloseRefusalNotice({
  refusal,
  onDiscardDraft,
  onKeepEditing,
}: {
  refusal: WorkspaceFileCloseRefusal | null
  onDiscardDraft: () => void
  onKeepEditing: () => void
}) {
  if (!refusal) return null
  return (
    <div className="workspace-file-close-refusal" role="status" data-tone="warning">
      <span className="workspace-file-close-refusal-message">
        {`已拒绝保存「${refusal.label}」：标签保持打开，未保存的修改还在，磁盘文件没有被改动。`}
      </span>
      <button type="button" className="workspace-file-close-refusal-action" onClick={onDiscardDraft}>
        放弃修改
      </button>
      <button type="button" className="workspace-file-close-refusal-action" onClick={onKeepEditing}>
        继续编辑
      </button>
    </div>
  )
}

/**
 * The tab strip plus the answer to a refused close.
 *
 * It renders the strip itself (nothing about the strip changes) and only intercepts
 * the close handler, so the refusal state stays next to the ✕ that produced it
 * instead of inside the panel.
 */
export function WorkspaceTabStripWithCloseRefusal({
  onCloseTab,
  openTabs,
  ...stripProps
}: Omit<ComponentProps<typeof WorkspaceTabStrip>, 'onCloseTab'> & {
  onCloseTab: WorkspaceFileTabCloseHandler
}) {
  const [refusal, setRefusal] = useState<WorkspaceFileCloseRefusal | null>(null)

  // A refusal only means something while its tab is still open.
  useEffect(() => {
    if (refusal && !openTabs.includes(refusal.tab)) setRefusal(null)
  }, [openTabs, refusal])

  async function requestClose(tab: Parameters<WorkspaceFileTabCloseHandler>[0]) {
    // A close that cannot finish still must not leave the notice stale: the refusal
    // is decided purely by the returned result.
    const result = await onCloseTab(tab).catch(() => undefined)
    const next = workspaceFileCloseRefusal(tab, result)
    // Closing some other tab must not silently take away this tab's discard path.
    setRefusal((current) => next ?? (current?.tab === tab ? null : current))
  }

  function discardRefusedDraft() {
    const target = refusal
    setRefusal(null)
    if (target) void onCloseTab(target.tab, { discardDraft: true }).catch(() => undefined)
  }

  return <>
    <WorkspaceTabStrip {...stripProps} openTabs={openTabs} onCloseTab={requestClose} />
    <WorkspaceFileCloseRefusalNotice
      refusal={refusal}
      onDiscardDraft={discardRefusedDraft}
      onKeepEditing={() => setRefusal(null)}
    />
  </>
}
