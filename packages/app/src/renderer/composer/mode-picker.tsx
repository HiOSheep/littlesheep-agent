// Task composer controls, attachments, runtime selection, and sizing.
import { useEffect,useRef,useState } from 'react'
import {
type PermissionModeId
} from '../api'
import { MODE_OPTIONS } from '../runtime/options'
import { FloatingHelpTip,FloatingHelpTooltip,buildFloatingHelpTip,buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { ModeRiskIcon } from '../ui/icons'
import { useDismissOnOutside } from '../ui/presence'
import { COMPOSER_MENU_EVENT,transientTriggerProps } from '../ui/transient'


export function ModePicker({
  value,
  onChange,
}: {
  value: PermissionModeId
  onChange: (value: PermissionModeId) => void
}) {
  const [open, setOpen] = useState(false)
  const [tip, setTip] = useState<FloatingHelpTip | null>(null)
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
      <div className="model-picker-panel option-picker-panel mode-picker-panel" role="dialog" aria-label="权限模式选择">
        <div className="option-picker-list" role="listbox" aria-label="权限模式">
          {MODE_OPTIONS.map((item) => {
            const isActive = item.id === value
            return (
              <button
                key={item.id}
                type="button"
                className={`model-option option-picker-option mode-option risk-${item.risk} ${isActive ? 'active' : ''}`}
                aria-label={`${item.label}: ${item.riskLabel}，${item.desc}`}
                onMouseEnter={(event) => setTip(buildFloatingHelpTip(item.desc, event.clientX, event.clientY))}
                onMouseMove={(event) => setTip(buildFloatingHelpTip(item.desc, event.clientX, event.clientY))}
                onMouseLeave={() => setTip(null)}
                onFocus={(event) => {
                  setTip(buildFloatingHelpTipFromElement(item.desc, event.currentTarget))
                }}
                onBlur={() => setTip(null)}
                onClick={() => {
                  if (!isActive) onChange(item.id)
                  setTip(null)
                  setOpen(false)
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
    </div>
  )
}
