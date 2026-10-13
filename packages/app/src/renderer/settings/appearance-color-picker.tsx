import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeScope } from '../ui/modal-surface'

type Hsv = { h: number; s: number; v: number }
const clamp = (value: number, max = 1) => Math.max(0, Math.min(max, value))

function toHsv(hex: string): Hsv {
  const [r, g, b] = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
  let h = 0
  if (delta) h = 60 * (max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4)
  return { h: (h + 360) % 360, s: max ? delta / max : 0, v: max }
}

function toHex({ h, s, v }: Hsv): string {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c
  const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return '#' + rgb.map(channel => Math.round((channel + m) * 255).toString(16).padStart(2, '0')).join('')
}

/** Application-owned popup: native color dialogs cannot share the app's corner and theme roles. */
export function AppearanceColorPicker({ label, value, anchor, onChange, onClose }: {
  label: string; value: string; anchor: RefObject<HTMLButtonElement>
  onChange: (value: string) => boolean; onClose: () => void
}) {
  const [hsv, setHsv] = useState(() => toHsv(value))
  const [position, setPosition] = useState({ left: 12, top: 12, width: 300 })
  const panel = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLDivElement>(null)
  const close = () => { onClose(); anchor.current?.focus({ preventScroll: true }) }
  useEscapeScope(close)

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(300, innerWidth - 24)
      const height = panel.current?.getBoundingClientRect().height ?? 330
      const below = innerHeight - rect.bottom - 12
      const top = below >= height ? rect.bottom + 8 : rect.top - height - 8
      setPosition({ width, left: Math.max(12, Math.min(rect.right - width, innerWidth - width - 12)), top: Math.max(12, Math.min(top, innerHeight - height - 12)) })
    }
    place()
    field.current?.focus({ preventScroll: true })
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [anchor])

  useEffect(() => {
    const outside = (event: globalThis.PointerEvent) => {
      const target = event.target as Node
      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) onClose()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [anchor, onClose])

  function update(next: Hsv) {
    setHsv(next)
    onChange(toHex(next))
  }
  function pick(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    update({ ...hsv, s: clamp((event.clientX - rect.left) / rect.width), v: 1 - clamp((event.clientY - rect.top) / rect.height) })
  }
  const hex = toHex(hsv)
  const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16))
  return createPortal(<div ref={panel} className="appearance-color-picker" style={position} role="dialog" aria-label={`${label}调色板`}
    onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== anchor.current) onClose() }}>
    <div className="appearance-picker-heading"><strong>{label}</strong><button type="button" aria-label="关闭调色板" onClick={close}>×</button></div>
    <div ref={field} className="appearance-picker-field" style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }} tabIndex={0} role="group"
      aria-label={`饱和度 ${Math.round(hsv.s * 100)}%，亮度 ${Math.round(hsv.v * 100)}%；方向键调整颜色`}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus(); pick(event) }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) pick(event) }}
      onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
      onKeyDown={event => {
        const step = event.shiftKey ? 0.1 : 0.01
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault()
          update({ ...hsv, s: clamp(hsv.s + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0)),
            v: clamp(hsv.v + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0)) })
        }
      }}>
      <span className="appearance-picker-point" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
    </div>
    <div className="appearance-picker-hue-row"><span className="appearance-picker-current" style={{ backgroundColor: hex }} />
      <input className="appearance-picker-hue" type="range" aria-label="色相" min={0} max={359} value={Math.round(hsv.h)}
        onChange={event => update({ ...hsv, h: Number(event.target.value) })} />
    </div>
    <div className="appearance-picker-rgb">{(['R', 'G', 'B'] as const).map((channel, index) =>
      <label key={channel}><input type="number" aria-label={`${label} ${channel}`} min={0} max={255} value={channels[index]}
        onChange={event => {
          if (event.target.value === '') return
          const next = channels.map((current, channelIndex) => channelIndex === index ? Math.round(clamp(Number(event.target.value), 255)) : current)
          update(toHsv('#' + next.map(current => current.toString(16).padStart(2, '0')).join('')))
        }} /><span>{channel}</span></label>)}</div>
  </div>, document.body)
}
