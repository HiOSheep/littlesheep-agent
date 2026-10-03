// Task composer controls, attachments, runtime selection, and sizing.
import { useEffect, useRef, useState } from 'react'
import { FloatingHelpTip } from '../ui/floating-help'
import { AddIcon } from '../ui/icons'
import { useDismissOnOutside } from '../ui/presence'
import { COMPOSER_MENU_EVENT, transientTriggerProps } from '../ui/transient'
import { useMenuFocusReturn } from './menu-focus-return'


export function AddMenu({
  label,
  onAddFiles,
  onChooseWorkspace,
  onTipChange,
}: {
  label: string
  onAddFiles: () => void | Promise<void>
  onChooseWorkspace: () => void | Promise<void>
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const captureMenuCaret = useMenuFocusReturn({ open, panelRef, triggerRef })

  // One close path: every reason the menu can go away goes through here, so the
  // caret the panel was holding is given back to the trigger (see
  // `menu-focus-return.ts`) instead of being dropped on the body.
  function closeMenu() {
    captureMenuCaret()
    setOpen(false)
  }

  useDismissOnOutside(open, [rootRef], closeMenu)

  useEffect(() => {
    const handleComposerMenuOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== 'add') closeMenu()
    }
    window.addEventListener(COMPOSER_MENU_EVENT, handleComposerMenuOpen)
    return () => window.removeEventListener(COMPOSER_MENU_EVENT, handleComposerMenuOpen)
  }, [])

  function runAction(action: () => void | Promise<void>) {
    closeMenu()
    onTipChange(null)
    void action()
  }

  return (
    <div ref={rootRef} className={`add-menu ${open ? 'open' : ''}`}>
      <button
        {...transientTriggerProps()}
        ref={triggerRef}
        className="icon-btn add-menu-trigger composer-tab-control"
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          onTipChange(null)
          if (open) {
            closeMenu()
            return
          }
          window.dispatchEvent(new CustomEvent(COMPOSER_MENU_EVENT, { detail: 'add' }))
          setOpen(true)
        }}
      >
        <AddIcon />
      </button>
      <div
        ref={panelRef}
        className="add-menu-panel"
        role="menu"
        aria-label="添加"
        aria-hidden={!open}
        {...(!open ? { inert: '' } : {})}
      >
        <div className="add-menu-title">添加</div>
        <button className="add-menu-item" type="button" role="menuitem" onClick={() => runAction(onAddFiles)}>
          <span className="add-menu-icon">+</span>
          <span className="add-menu-text">
            <strong>文件</strong>
            <small>添加图片或文档到这次请求</small>
          </span>
        </button>
        <button className="add-menu-item" type="button" role="menuitem" onClick={() => runAction(onChooseWorkspace)}>
          <span className="add-menu-icon">#</span>
          <span className="add-menu-text">
            <strong>目标工作区</strong>
            <small>指定这次任务在哪个文件夹里工作</small>
          </span>
        </button>
      </div>
    </div>
  )
}
