// A compact two-part control: the left segment does the current thing immediately, the chevron
// opens the list of alternatives. It is the shape the file preview and the terminal header use for
// "which application" and "which shell", so both read as one small pill instead of a labelled
// dropdown plus a separate action.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { clampNumber } from '../app-shell/navigation'
import { buildFloatingHelpTip, buildFloatingHelpTipFromElement, type FloatingHelpTip } from './floating-help'
import { useDismissOnOutside } from './presence'
import { transientTriggerProps } from './transient'

export interface SplitButtonItem {
  id: string
  label: string
  icon?: ReactNode
  hint?: string
  active?: boolean
  disabled?: boolean
  /** Draws a divider above this row: for entries that are a different kind of action. */
  dividerBefore?: boolean
  onSelect: () => void | Promise<void>
}

export function SplitButton({
  icon,
  label,
  primaryTip,
  items,
  menuLabel,
  disabled = false,
  busy = false,
  onTipChange,
  onPrimary,
  className = '',
}: {
  /** The current choice's own glyph, so the button says what it will do before it is used. */
  icon: ReactNode
  /** Accessible name; also the text of the row when the control shows one. */
  label: string
  primaryTip: string
  items: SplitButtonItem[]
  menuLabel: string
  disabled?: boolean
  busy?: boolean
  onTipChange?: (tip: FloatingHelpTip | null) => void
  onPrimary: () => void | Promise<void>
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const rootRef = useRef<HTMLDivElement>(null)
  const chevronRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // The menu is portalled to the body, so dismissal has to watch both the button and the panel.
  useDismissOnOutside(open, [rootRef, panelRef], () => setOpen(false))

  useLayoutEffect(() => {
    if (!open) return
    const trigger = chevronRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 10
    const panelWidth = panelRef.current?.offsetWidth || 232
    const panelHeight = panelRef.current?.offsetHeight || Math.min(320, items.length * 30 + 12)
    const x = clampNumber(rect.right - panelWidth, margin, window.innerWidth - panelWidth - margin)
    const below = rect.bottom + 4
    const y = below + panelHeight > window.innerHeight - margin
      ? Math.max(margin, rect.top - panelHeight - 4)
      : below
    setPosition({ x, y })
  }, [open, items.length])

  useEffect(() => {
    if (!disabled) return
    setOpen(false)
  }, [disabled])

  const tip = (text: string) => ({
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => onTipChange?.(buildFloatingHelpTip(text, event.clientX, event.clientY)),
    onMouseMove: (event: React.MouseEvent<HTMLElement>) => onTipChange?.(buildFloatingHelpTip(text, event.clientX, event.clientY)),
    onMouseLeave: () => onTipChange?.(null),
    onFocus: (event: React.FocusEvent<HTMLElement>) => onTipChange?.(buildFloatingHelpTipFromElement(text, event.currentTarget)),
    onBlur: () => onTipChange?.(null),
  })

  return (
    <div ref={rootRef} className={`split-button ${className} ${open ? 'open' : ''} ${busy ? 'busy' : ''}`}>
      <button
        {...transientTriggerProps()}
        className="split-button-primary"
        type="button"
        aria-label={label}
        disabled={disabled || busy}
        onClick={() => void onPrimary()}
        {...tip(primaryTip)}
      >
        <span className="split-button-icon" aria-hidden="true">{icon}</span>
      </button>
      <button
        {...transientTriggerProps()}
        ref={chevronRef}
        className="split-button-chevron"
        type="button"
        aria-label={menuLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          onTipChange?.(null)
          setOpen((value) => !value)
        }}
        {...tip(menuLabel)}
      >
        <svg className="split-button-chevron-icon" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="m2.6 4.4 3.4 3.4 3.4-3.4" />
        </svg>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className="split-button-menu"
          role="menu"
          aria-label={menuLabel}
          style={{ left: position.x, top: position.y }}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.active === true}
              className={`split-button-menu-item ${item.active ? 'active' : ''} ${item.dividerBefore ? 'divider-before' : ''}`}
              disabled={item.disabled === true}
              title={item.hint}
              onClick={() => {
                setOpen(false)
                onTipChange?.(null)
                void item.onSelect()
              }}
            >
              {/* The icon cell is always rendered, even when empty: with a two-column grid an
                  iconless row would otherwise put its label in the 18px icon column. */}
              <span className="split-button-menu-icon" aria-hidden="true">{item.icon}</span>
              <span className="split-button-menu-label">{item.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
