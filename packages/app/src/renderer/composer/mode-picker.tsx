// Task composer controls, attachments, runtime selection, and sizing.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  type PermissionModeId
} from '../api'
import { MODE_OPTIONS } from '../runtime/options'
import { FloatingHelpTip, FloatingHelpTooltip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { ModeRiskIcon } from '../ui/icons'
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
  const [tip, setTip] = useState<FloatingHelpTip | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const selected = MODE_OPTIONS.find((item) => item.id === value) ?? MODE_OPTIONS[0]!

  function buildModeOptionTip(text: string, element: HTMLElement): FloatingHelpTip {
    return buildFloatingHelpTipFromElement(text, element, {
      placement: 'right',
      avoidElement: panelRef.current,
    })
  }

  useDismissOnOutside(open, [rootRef], () => setOpen(false))

  useEffect(() => {
    const handleComposerMenuOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== 'mode') setOpen(false)
    }
    window.addEventListener(COMPOSER_MENU_EVENT, handleComposerMenuOpen)
    return () => window.removeEventListener(COMPOSER_MENU_EVENT, handleComposerMenuOpen)
  }, [])

  useEffect(() => {
    if (!open) setTip(null)
  }, [open])

  return (
    <div ref={rootRef} className={`model-picker option-picker mode-picker risk-${selected.risk} ${open ? 'open' : ''}`}>
      <button
        {...transientTriggerProps()}
        type="button"
        className="model-picker-trigger mode-picker-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${selected.label}: ${selected.riskLabel}，${selected.desc}`}
        onMouseEnter={(event) => {
          if (!open && selected?.desc) setTip(buildFloatingHelpTip(selected.desc, event.clientX, event.clientY))
        }}
        onMouseMove={(event) => {
          if (!open && selected?.desc) setTip(buildFloatingHelpTip(selected.desc, event.clientX, event.clientY))
        }}
        onMouseLeave={() => setTip(null)}
        onFocus={(event) => {
          if (open || !selected?.desc) return
          setTip(buildFloatingHelpTipFromElement(selected.desc, event.currentTarget))
        }}
        onBlur={() => setTip(null)}
        onClick={() => {
          setTip(null)
          setOpen((current) => {
            const next = !current
            if (next) window.dispatchEvent(new CustomEvent(COMPOSER_MENU_EVENT, { detail: 'mode' }))
            return next
          })
        }}
      >
        <ModeRiskIcon risk={selected.risk} className="mode-picker-mark" />
        <span className="model-picker-current">{selected.label}</span>
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
                onMouseEnter={(event) => setTip(buildModeOptionTip(item.desc, event.currentTarget))}
                onMouseMove={(event) => setTip(buildModeOptionTip(item.desc, event.currentTarget))}
                onMouseLeave={() => setTip(null)}
                onFocus={(event) => {
                  setTip(buildModeOptionTip(item.desc, event.currentTarget))
                }}
                onBlur={() => setTip(null)}
                onClick={() => {
                  setTip(null)
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
                <span>{item.label}</span>
              </button>
            )
          })}
        </div>
      </div>
      <FloatingHelpTooltip tip={tip} />
      <FullAccessWarning
        show={confirmingFullAccess}
        onCancel={() => setConfirmingFullAccess(false)}
        onConfirm={() => {
          setConfirmingFullAccess(false)
          onChange('full')
        }}
      />
    </div>
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
  return createPortal(
    <FadePresence show={show} exitMs={220} className="approval-presence full-access-warning-presence">
      <div
        className="approval-layer"
        role="presentation"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
        }}
      >
        <section className="approval-prompt full-access-warning" role="alertdialog" aria-modal="true" aria-label="启用完全访问">
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
            <button type="button" className="approval-action primary danger" autoFocus onClick={onConfirm}>
              启用完全访问
            </button>
          </div>
        </section>
      </div>
    </FadePresence>,
    document.body,
  )
}
