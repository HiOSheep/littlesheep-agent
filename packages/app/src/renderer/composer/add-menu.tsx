// Task composer controls, attachments, runtime selection, and sizing.
import { useEffect, useRef, useState } from 'react'
import { FloatingHelpTip } from '../ui/floating-help'
import { useDismissOnOutside } from '../ui/presence'
import { COMPOSER_MENU_EVENT, transientTriggerProps } from '../ui/transient'


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

  useDismissOnOutside(open, [rootRef], () => setOpen(false))

  useEffect(() => {
    const handleComposerMenuOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== 'add') setOpen(false)
    }
    window.addEventListener(COMPOSER_MENU_EVENT, handleComposerMenuOpen)
    return () => window.removeEventListener(COMPOSER_MENU_EVENT, handleComposerMenuOpen)
  }, [])

  function runAction(action: () => void | Promise<void>) {
    setOpen(false)
    onTipChange(null)
    void action()
  }

  return (
    <div ref={rootRef} className={`add-menu ${open ? 'open' : ''}`}>
      <button
        {...transientTriggerProps()}
        className="icon-btn add-menu-trigger composer-tab-control"
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          onTipChange(null)
          setOpen((value) => {
            const next = !value
            if (next) window.dispatchEvent(new CustomEvent(COMPOSER_MENU_EVENT, { detail: 'add' }))
            return next
          })
        }}
      >
        +
      </button>
      <div
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
