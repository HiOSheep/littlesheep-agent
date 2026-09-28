import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeScope } from '../ui/modal-surface'

export interface SettingsOption<T extends string> {
  value: T
  label: string
  description?: string
  disabled?: boolean
}

/** A settings value button with a viewport-bound, keyboard-accessible menu. */
export function SettingsSelect<T extends string>({ label, value, options, disabled = false, onChange }: {
  label: string
  value: T
  options: readonly SettingsOption<T>[]
  disabled?: boolean
  onChange: (value: T) => void
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 260, maxHeight: 320 })
  const selected = options.find(option => option.value === value)
  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus({ preventScroll: true })
  }
  useEscapeScope(() => close(true), open)

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(Math.max(260, rect.width), window.innerWidth - 24)
      const below = window.innerHeight - rect.bottom - 16
      const above = rect.top - 16
      const height = Math.min(menu.current?.scrollHeight || 320, 320)
      const up = below < height && above > below
      const maxHeight = Math.max(40, Math.min(320, up ? above : below))
      setPosition({ width, maxHeight,
        left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        top: up ? Math.max(12, rect.top - Math.min(height, maxHeight) - 6) : rect.bottom + 6,
      })
    }
    place()
    const active = menu.current?.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)')
      ?? menu.current?.querySelector<HTMLElement>('button:not(:disabled)')
    active?.focus({ preventScroll: true })
    window.addEventListener('resize', place)
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) place() }
    window.addEventListener('scroll', scroll, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', scroll, true)
    }
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) close()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.isDefaultPrevented() || event.nativeEvent.isComposing) return
    if (event.key === 'Tab') { close(true); return }
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    let next: number | undefined
    if (event.key === 'ArrowDown') next = (index + 1) % buttons.length
    if (event.key === 'ArrowUp') next = (index + buttons.length - 1) % buttons.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = buttons.length - 1
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      const match = buttons.findIndex((button, offset) => offset > index && button.textContent?.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()))
      next = match >= 0 ? match : buttons.findIndex(button => button.textContent?.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()))
    }
    if (next !== undefined && next >= 0 && buttons[next]) {
      event.preventDefault()
      buttons[next]!.focus()
    }
  }

  return <>
    <button ref={trigger} type="button" className="settings-select" aria-label={label}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={disabled} onClick={() => setOpen(current => !current)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) }
      }}>
      <span>{selected?.label ?? value}</span>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {open && !disabled && createPortal(<div ref={menu} id={id} role="menu" aria-label={label}
      className="settings-select-menu" style={position} onKeyDown={onMenuKeyDown}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) close() }}>
      {options.map(option => <button key={option.value} type="button" role="menuitemradio"
        aria-checked={option.value === value} disabled={option.disabled} tabIndex={-1}
        title={option.description} onClick={() => { close(true); if (option.value !== value) onChange(option.value) }}>
        <span>{option.label}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true" style={{ visibility: option.value === value ? 'visible' : 'hidden' }}><path d="m3 8 3 3 7-8" /></svg>
      </button>)}
    </div>, document.body)}
  </>
}
