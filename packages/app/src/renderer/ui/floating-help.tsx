// Reusable renderer interaction primitives and icons.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'


export const FLOATING_HELP_DELAY_MS = 500

export const FLOATING_HELP_EXIT_MS = 150

export const FLOATING_HELP_VIEWPORT_MARGIN_PX = 12


export interface FloatingHelpTip {
  text: string
  x: number
  y: number
  placement?: FloatingHelpPlacement
  avoidRect?: FloatingHelpRect
}


export interface FloatingHelpPosition {
  x: number
  y: number
}


export type FloatingHelpPlacement = 'right' | 'left' | 'below' | 'above'


export interface FloatingHelpRect {
  left: number
  top: number
  right: number
  bottom: number
}


export interface FloatingHelpElementOptions {
  placement?: FloatingHelpPlacement
  avoidElement?: HTMLElement | null
}


export function clampFloatingHelpTipPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): FloatingHelpPosition {
  const margin = FLOATING_HELP_VIEWPORT_MARGIN_PX
  const maxX = Math.max(margin, viewportWidth - width - margin)
  const maxY = Math.max(margin, viewportHeight - height - margin)
  return {
    x: Math.min(Math.max(margin, x), maxX),
    y: Math.min(Math.max(margin, y), maxY),
  }
}


export function buildFloatingHelpTip(text: string, clientX: number, clientY: number): FloatingHelpTip {
  return {
    text,
    x: clientX + 14,
    y: clientY + 10,
  }
}


export function buildFloatingHelpTipFromElement(
  text: string,
  element: HTMLElement,
  options: FloatingHelpElementOptions = {},
): FloatingHelpTip {
  const rect = element.getBoundingClientRect()
  const tip = buildFloatingHelpTip(text, rect.right, rect.top + rect.height / 2)
  const avoidRect = options.avoidElement?.getBoundingClientRect()
  if (!options.placement && !avoidRect) return tip
  return {
    ...tip,
    ...(options.placement ? {
      placement: options.placement,
      // Side placements are centered on the trigger instead of using the
      // cursor tooltip's small downward offset.
      y: rect.top + rect.height / 2,
    } : {}),
    ...(avoidRect ? {
      avoidRect: {
        left: avoidRect.left,
        top: avoidRect.top,
        right: avoidRect.right,
        bottom: avoidRect.bottom,
      },
    } : {}),
  }
}


export function FloatingHelpTooltip({ tip }: { tip: FloatingHelpTip | null }) {
  const [renderedTip, setRenderedTip] = useState<FloatingHelpTip | null>(null)
  const [position, setPosition] = useState<FloatingHelpPosition | null>(null)
  const [shown, setShown] = useState(false)
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const tipRef = useRef<FloatingHelpTip | null>(tip)
  const renderedTipRef = useRef<FloatingHelpTip | null>(null)
  const activeRef = useRef(false)
  const tokenRef = useRef(0)
  const frameRef = useRef<number>()

  // Pointer movement changes the anchor position, not the tooltip identity.
  // Keep it out of the delayed show/hide lifecycle so mouse movement cannot
  // repeatedly rebuild the transient layer.
  useEffect(() => {
    tipRef.current = tip
    if (!tip || !activeRef.current || renderedTipRef.current?.text !== tip.text) return
    renderedTipRef.current = tip
    setRenderedTip(tip)
  }, [tip])

  useEffect(() => {
    const token = tokenRef.current + 1
    tokenRef.current = token
    window.cancelAnimationFrame(frameRef.current ?? 0)
    const tipText = tip?.text ?? null

    if (!tipText) {
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
      const currentTip = tipRef.current
      if (currentTip) {
        renderedTipRef.current = currentTip
        setRenderedTip(currentTip)
      }
      setShown(true)
      return
    }

    setShown(false)
    const showTimer = window.setTimeout(() => {
      if (tokenRef.current !== token) return
      const currentTip = tipRef.current
      if (!currentTip || currentTip.text !== tipText) return
      renderedTipRef.current = currentTip
      activeRef.current = true
      setRenderedTip(currentTip)
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = undefined
        if (tokenRef.current === token) setShown(true)
      })
    }, FLOATING_HELP_DELAY_MS)
    return () => {
      window.clearTimeout(showTimer)
      window.cancelAnimationFrame(frameRef.current ?? 0)
    }
  }, [tip?.text])

  useLayoutEffect(() => {
    const element = tooltipRef.current
    if (!renderedTip || !element) return
    setPositionIfChanged(measureFloatingHelpTipPosition(renderedTip, element))
  }, [renderedTip])

  useEffect(() => {
    const updatePosition = () => {
      const currentTip = renderedTipRef.current
      const element = tooltipRef.current
      if (!currentTip || !element) return
      setPositionIfChanged(measureFloatingHelpTipPosition(currentTip, element))
    }
    window.addEventListener('resize', updatePosition)
    return () => window.removeEventListener('resize', updatePosition)
  }, [])

  function setPositionIfChanged(nextPosition: FloatingHelpPosition) {
    setPosition((current) => current?.x === nextPosition.x && current.y === nextPosition.y
      ? current
      : nextPosition)
  }

  if (!renderedTip) return null
  const renderedPosition = position ?? renderedTip
  return createPortal(
    <div
      ref={tooltipRef}
      className={`floating-help-tip ${shown ? 'visible' : ''}`}
      style={{ left: renderedPosition.x, top: renderedPosition.y }}
    >
      {renderedTip.text}
    </div>,
    document.body,
  )
}


function measureFloatingHelpTipPosition(
  tip: FloatingHelpTip,
  element: HTMLDivElement,
): FloatingHelpPosition {
  const layout = resolveFloatingHelpLayout(tip, window.innerWidth)
  if (layout.maxWidth !== undefined) {
    element.style.maxWidth = `${layout.maxWidth}px`
  } else {
    element.style.removeProperty('max-width')
  }
  const rect = element.getBoundingClientRect()
  let x = tip.x
  let y = tip.y
  const avoidRect = tip.avoidRect
  if (avoidRect && layout.placement) {
    switch (layout.placement) {
      case 'right':
        x = avoidRect.right + FLOATING_HELP_SIDE_GAP_PX
        y = tip.y - rect.height / 2
        break
      case 'left':
        x = avoidRect.left - FLOATING_HELP_SIDE_GAP_PX - rect.width
        y = tip.y - rect.height / 2
        break
      case 'below':
        x = avoidRect.left
        y = avoidRect.bottom + FLOATING_HELP_SIDE_GAP_PX
        break
      case 'above':
        x = avoidRect.left
        y = avoidRect.top - FLOATING_HELP_SIDE_GAP_PX - rect.height
        break
    }
  }
  return clampFloatingHelpTipPosition(
    x,
    y,
    rect.width,
    rect.height,
    window.innerWidth,
    window.innerHeight,
  )
}


const FLOATING_HELP_SIDE_GAP_PX = 10
const FLOATING_HELP_MIN_SIDE_WIDTH_PX = 180


export function resolveFloatingHelpLayout(
  tip: Pick<FloatingHelpTip, 'placement' | 'avoidRect'>,
  viewportWidth: number,
): { placement?: FloatingHelpPlacement; maxWidth?: number } {
  if (!tip.placement || !tip.avoidRect) return {}

  const margin = FLOATING_HELP_VIEWPORT_MARGIN_PX
  const rightWidth = Math.floor(viewportWidth - margin - tip.avoidRect.right - FLOATING_HELP_SIDE_GAP_PX)
  const leftWidth = Math.floor(tip.avoidRect.left - margin - FLOATING_HELP_SIDE_GAP_PX)
  const viewportWidthLimit = Math.max(0, viewportWidth - margin * 2)

  if (tip.placement === 'right' && rightWidth >= FLOATING_HELP_MIN_SIDE_WIDTH_PX) {
    return { placement: 'right', maxWidth: rightWidth }
  }
  if (tip.placement === 'left' && leftWidth >= FLOATING_HELP_MIN_SIDE_WIDTH_PX) {
    return { placement: 'left', maxWidth: leftWidth }
  }
  if (leftWidth >= FLOATING_HELP_MIN_SIDE_WIDTH_PX) {
    return { placement: 'left', maxWidth: leftWidth }
  }
  if (rightWidth >= FLOATING_HELP_MIN_SIDE_WIDTH_PX) {
    return { placement: 'right', maxWidth: rightWidth }
  }

  // When neither side has enough room, keep the tooltip readable and place it
  // outside the avoided surface vertically. The final viewport clamp handles
  // very short windows without allowing it to escape the window.
  return {
    placement: tip.placement === 'above' ? 'above' : 'below',
    maxWidth: viewportWidthLimit,
  }
}
