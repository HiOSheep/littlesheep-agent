// Reusable renderer interaction primitives and icons.
import { useEffect,useRef,useState } from 'react'
import { createPortal } from 'react-dom'


export const FLOATING_HELP_DELAY_MS = 500

export const FLOATING_HELP_EXIT_MS = 150


export interface FloatingHelpTip {
  text: string
  x: number
  y: number
}


export function buildFloatingHelpTip(text: string, clientX: number, clientY: number): FloatingHelpTip {
  const maxWidth = 260
  const maxHeight = 86
  const margin = 12
  const x = Math.min(clientX + 14, window.innerWidth - maxWidth - margin)
  const y = Math.min(clientY + 10, window.innerHeight - maxHeight - margin)
  return {
    text,
    x: Math.max(margin, x),
    y: Math.max(margin, y),
  }
}


export function buildFloatingHelpTipFromElement(text: string, element: HTMLElement): FloatingHelpTip {
  const rect = element.getBoundingClientRect()
  return buildFloatingHelpTip(text, rect.right, rect.top + rect.height / 2)
}


export function FloatingHelpTooltip({ tip }: { tip: FloatingHelpTip | null }) {
  const [renderedTip, setRenderedTip] = useState<FloatingHelpTip | null>(null)
  const [shown, setShown] = useState(false)
  const renderedTipRef = useRef<FloatingHelpTip | null>(null)
  const activeRef = useRef(false)
  const tokenRef = useRef(0)
  const frameRef = useRef<number>()

  useEffect(() => {
    const token = tokenRef.current + 1
    tokenRef.current = token
    window.cancelAnimationFrame(frameRef.current ?? 0)

    if (!tip) {
      setShown(false)
      const hideTimer = window.setTimeout(() => {
        if (tokenRef.current !== token) return
        renderedTipRef.current = null
        activeRef.current = false
        setRenderedTip(null)
      }, FLOATING_HELP_EXIT_MS)
      return () => window.clearTimeout(hideTimer)
    }

    if (activeRef.current && renderedTipRef.current) {
      renderedTipRef.current = tip
      setRenderedTip(tip)
      setShown(true)
      return
    }

    setShown(false)
    const showTimer = window.setTimeout(() => {
      if (tokenRef.current !== token) return
      renderedTipRef.current = tip
      activeRef.current = true
      setRenderedTip(tip)
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = undefined
        if (tokenRef.current === token) setShown(true)
      })
    }, FLOATING_HELP_DELAY_MS)
    return () => {
      window.clearTimeout(showTimer)
      window.cancelAnimationFrame(frameRef.current ?? 0)
    }
  }, [tip])

  if (!renderedTip) return null
  return createPortal(
    <div
      className={`floating-help-tip ${shown ? 'visible' : ''}`}
      style={{ left: renderedTip.x, top: renderedTip.y }}
    >
      {renderedTip.text}
    </div>,
    document.body,
  )
}
