import { useLayoutEffect, useRef } from 'react'

export const OVERFLOWING_LABEL_SCROLL_SPEED_PX_PER_SECOND = 32

export interface OverflowingLabelMotion {
  durationMs: number
  offsetPx: number
  overflowPx: number
}

export function resolveOverflowingLabelMotion(
  viewportWidth: number,
  contentWidth: number,
): OverflowingLabelMotion {
  const measuredOverflow = Math.max(0, Math.ceil(contentWidth - viewportWidth))
  const overflowPx = measuredOverflow > 1 ? measuredOverflow : 0
  return {
    durationMs: overflowPx === 0
      ? 0
      : Math.max(1, Math.round((overflowPx / OVERFLOWING_LABEL_SCROLL_SPEED_PX_PER_SECOND) * 1_000)),
    offsetPx: overflowPx === 0 ? 0 : -overflowPx,
    overflowPx,
  }
}

export function OverflowingLabel({
  label,
  className,
  textClassName,
}: {
  label: string
  className?: string
  textClassName?: string
}) {
  const viewportRef = useRef<HTMLSpanElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    let active = true
    const viewport = viewportRef.current
    const text = textRef.current
    if (!viewport || !text) return

    const updateMotion = () => {
      if (!active) return
      const motion = resolveOverflowingLabelMotion(viewport.clientWidth, text.scrollWidth)
      viewport.classList.toggle('is-overflowing', motion.overflowPx > 0)
      viewport.style.setProperty('--overflowing-label-offset', `${motion.offsetPx}px`)
      viewport.style.setProperty('--overflowing-label-scroll-duration', `${motion.durationMs}ms`)
    }

    const frame = window.requestAnimationFrame(updateMotion)
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateMotion)
    observer?.observe(viewport)
    observer?.observe(text)
    window.addEventListener('resize', updateMotion)
    void document.fonts?.ready.then(updateMotion)

    return () => {
      active = false
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', updateMotion)
    }
  }, [label])

  return (
    <span
      ref={viewportRef}
      className={`overflowing-label${className ? ` ${className}` : ''}`}
    >
      <span
        ref={textRef}
        className={`overflowing-label-text${textClassName ? ` ${textClassName}` : ''}`}
      >
        {label}
      </span>
    </span>
  )
}
