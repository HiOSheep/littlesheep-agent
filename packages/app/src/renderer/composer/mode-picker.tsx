// Task composer controls, attachments, runtime selection, and sizing.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  type PermissionModeId
} from '../api'
import { MODE_OPTIONS } from '../runtime/options'
import { ModeRiskIcon } from '../ui/icons'
import { useModalSurface } from '../ui/modal-surface'
import { FadePresence, useDismissOnOutside } from '../ui/presence'
import { COMPOSER_MENU_EVENT, transientTriggerProps } from '../ui/transient'


export function ModePicker({
  value,
  onChange,
}: {
  value: PermissionModeId
  onChange: (value: PermissionModeId) => void
}) {
  const [open, setOpen] = useState(false)
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = MODE_OPTIONS.find((item) => item.id === value) ?? MODE_OPTIONS[0]!

  useDismissOnOutside(open, [rootRef], () => setOpen(false))

  useEffect(() => {
    const handleComposerMenuOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== 'mode') setOpen(false)
    }
    window.addEventListener(COMPOSER_MENU_EVENT, handleComposerMenuOpen)
    return () => window.removeEventListener(COMPOSER_MENU_EVENT, handleComposerMenuOpen)
  }, [])

  return (
    <div ref={rootRef} className={`model-picker option-picker mode-picker risk-${selected.risk} ${open ? 'open' : ''}`}>
      <button
        {...transientTriggerProps()}
        type="button"
        className="model-picker-trigger mode-picker-trigger composer-tab-control"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${selected.label}: ${selected.riskLabel}，${selected.desc}`}
        onClick={() => {
          setOpen((current) => {
            const next = !current
            if (next) window.dispatchEvent(new CustomEvent(COMPOSER_MENU_EVENT, { detail: 'mode' }))
            return next
          })
        }}
      >
        <span className="mode-picker-content">
          <ModeRiskIcon risk={selected.risk} className="mode-picker-mark" />
          <span className="model-picker-current">{selected.label}</span>
        </span>
      </button>
      <div
        className="model-picker-panel option-picker-panel mode-picker-panel"
        role="dialog"
        aria-label="权限模式选择"
        aria-hidden={!open}
        {...(!open ? { inert: '' } : {})}
      >
        <div className="option-picker-list" role="listbox" aria-label="权限模式">
          {MODE_OPTIONS.map((item) => {
            const isActive = item.id === value
            return (
              <button
                key={item.id}
                type="button"
                className={`model-option option-picker-option mode-option risk-${item.risk} ${isActive ? 'active' : ''}`}
                aria-label={`${item.label}: ${item.riskLabel}，${item.desc}`}
                onClick={() => {
                  setOpen(false)
                  if (isActive) return
                  if (requiresFullAccessConfirmation(value, item.id)) {
                    setConfirmingFullAccess(true)
                    return
                  }
                  onChange(item.id)
                }}
              >
                <ModeRiskIcon risk={item.risk} className="mode-option-mark" />
                <span className="mode-option-copy">
                  <span>{item.label}</span>
                  <small>{item.desc}</small>
                </span>
              </button>
            )
          })}
        </div>
      </div>
      <FullAccessWarning
        show={confirmingFullAccess}
        onCancel={() => setConfirmingFullAccess(false)}
        onConfirm={() => {
          setConfirmingFullAccess(false)
          onChange('full')
        }}
      />    </div>
  )
}

export function requiresFullAccessConfirmation(
  current: PermissionModeId,
  next: PermissionModeId,
): boolean {
  return current !== 'full' && next === 'full'
}

function FullAccessWarning({
  show,
  onCancel,
  onConfirm,
}: {
  show: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialogRef = useRef<HTMLElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  // A confirm on top of the open picker: Escape belongs to this layer only, so
  // one press cancels the warning instead of collapsing the picker with it. The
  // red confirmation keeps its deliberate initial focus.
  useModalSurface(dialogRef, {
    active: show,
    onEscape: onCancel,
    initialFocusRef: confirmRef,
  })
  return createPortal(
    <FadePresence show={show} exitMs={220} className="approval-presence full-access-warning-presence">
      <div className="approval-layer" role="presentation">
        <section
          ref={dialogRef}
          className="approval-prompt full-access-warning"
          role="alertdialog"
          aria-modal="true"
          aria-label="启用完全访问"
          tabIndex={-1}
        >
          <div className="approval-kicker">最高权限警告</div>
          <h2>启用完全访问？</h2>
          <p>启用后，LittleSheep 无需逐次询问即可访问容器内外及范围不明的资源。</p>
          <ul className="full-access-warning-list">
            <li>读取、创建、修改或删除外部文件与目录</li>
            <li>在外部工作区执行命令并启动本地进程</li>
            <li>访问动态命令涉及的宿主资源</li>
          </ul>
          <p className="approval-session-note">LS 核心源码只读保护和危险命令硬拒绝仍然有效。你可以随时切回研究或受限模式。</p>
          <div className="approval-actions">
            <button type="button" className="approval-action" onClick={onCancel}>
              取消
            </button>
            <button ref={confirmRef} type="button" className="approval-action primary danger" onClick={onConfirm}>
              启用完全访问
            </button>
          </div>
        </section>
      </div>
    </FadePresence>,
    document.body,
  )
}
