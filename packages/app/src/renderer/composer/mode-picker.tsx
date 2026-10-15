// Task composer controls, attachments, runtime selection, and sizing.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { type PermissionSelectionId } from '../api'
import { MODE_OPTIONS } from '../runtime/options'
import { ModeRiskIcon } from '../ui/icons'
import { useModalSurface } from '../ui/modal-surface'
import { FadePresence, useDismissOnOutside } from '../ui/presence'
import { COMPOSER_MENU_EVENT, transientTriggerProps } from '../ui/transient'
import { useMenuFocusReturn } from './menu-focus-return'


export function ModePicker({
  value,
  onChange,
}: {
  value: PermissionSelectionId
  onChange: (value: PermissionSelectionId) => void
}) {
  const [open, setOpen] = useState(false)
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const captureMenuCaret = useMenuFocusReturn({ open, panelRef, triggerRef })
  const selected = MODE_OPTIONS.find((item) => item.id === value) ?? MODE_OPTIONS[0]!

  // One close path for the permission menu, so choosing an option and dismissing
  // it both hand the caret back to the trigger (see `menu-focus-return.ts`).
  function closeMenu() {
    captureMenuCaret()
    setOpen(false)
  }

  useDismissOnOutside(open, [rootRef], closeMenu)

  useEffect(() => {
    const handleComposerMenuOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== 'mode') closeMenu()
    }
    window.addEventListener(COMPOSER_MENU_EVENT, handleComposerMenuOpen)
    return () => window.removeEventListener(COMPOSER_MENU_EVENT, handleComposerMenuOpen)
  }, [])

  return (
    <div ref={rootRef} className={`model-picker option-picker mode-picker risk-${selected.risk} ${open ? 'open' : ''}`}>
      <button
        {...transientTriggerProps()}
        ref={triggerRef}
        type="button"
        className="model-picker-trigger mode-picker-trigger composer-tab-control"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${selected.label}: ${selected.riskLabel}，${selected.desc}`}
        onClick={() => {
          if (open) {
            closeMenu()
            return
          }
          window.dispatchEvent(new CustomEvent(COMPOSER_MENU_EVENT, { detail: 'mode' }))
          setOpen(true)
        }}
      >
        <span className="mode-picker-content">
          <ModeRiskIcon risk={selected.risk} className="mode-picker-mark" />
          <span className="model-picker-current">{selected.label}</span>
        </span>
      </button>
      <div
        ref={panelRef}
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
                  closeMenu()
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
          onChange('full-access')
        }}
      />    </div>
  )
}

export function requiresFullAccessConfirmation(
  current: PermissionSelectionId,
  next: PermissionSelectionId,
): boolean {
  return current !== 'full-access' && next === 'full-access'
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
          <p>启用后，内置工具可按 Main 当前权限策略访问更广范围的本地资源；Shell 与强制审批操作仍需逐次确认。</p>
          <ul className="full-access-warning-list">
            <li>读取、创建、修改或删除外部文件与目录</li>
            <li>Shell 命令会在当前用户的宿主环境运行，没有 OS 级沙箱；工作区范围不会限制命令</li>
            <li>命令可能访问此用户可访问的其他文件、启动本地进程或使用网络</li>
            <li>访问动态命令涉及的宿主资源</li>
          </ul>
          <p className="approval-session-note">LS 会对内置工具执行核心源码保护检查；宿主 Shell 未经过 OS 级隔离，因此无法保证命令或其子进程不能绕过应用层检查并改写这些文件。内置硬拒绝规则仍会执行，但不构成宿主级防护。你可以随时切回只读或工作区写入。</p>
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
