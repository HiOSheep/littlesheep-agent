// Minimal confirmation layer for irreversible deletions.
//
// It shows the object, the impact and what stays in place, keeps the initial
// focus on "取消", traps Tab inside the dialog, gives Escape only to the
// topmost layer, and disables both actions while the request is in flight so a
// repeated click cannot submit a second delete. Focus returns to the element
// that opened the confirmation when it closes.
//
// The in-flight state is published as `aria-busy` and the failure carries the
// shared failure mark next to its sentence: the disabled buttons alone would only
// say "you cannot press this", not "a delete is already running" or "it failed".
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DeletionImpact } from '../deletion-impact'
import { useModalSurface } from './modal-surface'
import { FailureIcon } from './state-icons'

/** Shared by object menus so every permanent-delete entry uses the same confirmation. */
export function useDangerConfirmation() {
  const [pending, setPending] = useState<{ impact: DeletionImpact; run: () => void | Promise<void> } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  const requestDeletion = (impact: DeletionImpact, run: () => void | Promise<void>) => {
    if (busyRef.current) return
    setError(null)
    setPending({ impact, run })
  }
  const confirm = async () => {
    if (!pending || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await pending.run()
      if (mountedRef.current) setPending(null)
    } catch (reason) {
      if (mountedRef.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      busyRef.current = false
      if (mountedRef.current) setBusy(false)
    }
  }
  const confirmation = pending && createPortal(<DangerConfirmDialog impact={pending.impact} busy={busy} error={error}
    onCancel={() => { if (!busyRef.current) setPending(null) }} onConfirm={() => void confirm()} />, document.body)
  return { requestDeletion, confirmation }
}

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
    <div className="overlay danger-confirm-overlay" onClick={busy ? undefined : onCancel}>
      <div
        ref={dialogRef}
        className="dialog danger-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={heading}
        aria-busy={busy ? true : undefined}
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
        {error && (
          <div className="dialog-error" role="alert">
            <span className="feedback-icon" aria-hidden="true"><FailureIcon /></span>
            <span>{error}</span>
          </div>
        )}
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
