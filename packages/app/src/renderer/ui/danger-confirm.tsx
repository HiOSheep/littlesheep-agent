// Minimal confirmation layer for irreversible deletions.
//
// It shows the object, the impact and what stays in place, keeps the initial
// focus on "取消", traps Tab inside the dialog, gives Escape only to the
// topmost layer, and disables both actions while the request is in flight so a
// repeated click cannot submit a second delete. Focus returns to the element
// that opened the confirmation when it closes.
import { useRef } from 'react'
import type { DeletionImpact } from '../deletion-impact'
import { useModalSurface } from './modal-surface'

export function DangerConfirmDialog({
  impact,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  impact: DeletionImpact
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const heading = `永久删除${impact.objectType}？`

  useModalSurface(dialogRef, {
    active: true,
    onEscape: () => {
      if (!busy) onCancel()
    },
    initialFocusRef: cancelRef,
  })

  return (
    <div className="overlay" onClick={busy ? undefined : onCancel}>
      <div
        ref={dialogRef}
        className="dialog danger-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={heading}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <h2>{heading}</h2>
        </div>
        <p className="danger-confirm-name">{impact.name}</p>
        <ul className="danger-confirm-list">
          {impact.removes.map((line) => <li key={line}>{line}</li>)}
        </ul>
        {impact.preserved.length > 0 && (
          <ul className="danger-confirm-preserved">
            {impact.preserved.map((line) => <li key={line}>{line}</li>)}
          </ul>
        )}
        {impact.inUse && <div className="danger-confirm-inuse">{impact.inUse}</div>}
        {error && <div className="dialog-error" role="alert">{error}</div>}
        <div className="dialog-footer">
          <button ref={cancelRef} className="close-btn" type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button className="danger-btn" type="button" disabled={busy} onClick={onConfirm}>
            {busy ? '删除中…' : '永久删除'}
          </button>
        </div>
      </div>
    </div>
  )
}
