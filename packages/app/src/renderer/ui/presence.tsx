// Reusable renderer interaction primitives and icons.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { isTransientTriggerTarget } from './transient'


export type PresencePhase = 'entering' | 'open' | 'exiting'


export function FadePresence({
  show,
  children,
  exitMs = 190,
  className = '',
}: {
  show: boolean
  children: ReactNode
  exitMs?: number
  className?: string
}) {
  const [mounted, setMounted] = useState(show)
  const [visible, setVisible] = useState(false)
  const [phase, setPhase] = useState<PresencePhase>(show ? 'open' : 'exiting')

  useLayoutEffect(() => {
    let frame = 0
    let innerFrame = 0
    let timer = 0
    let settleTimer = 0

    if (show) {
      setPhase('entering')
      setMounted(true)
      if (mounted) {
        setVisible(true)
        settleTimer = window.setTimeout(() => setPhase('open'), exitMs)
      } else {
        setVisible(false)
        frame = window.requestAnimationFrame(() => {
          innerFrame = window.requestAnimationFrame(() => {
            setVisible(true)
            settleTimer = window.setTimeout(() => setPhase('open'), exitMs)
          })
        })
      }
      return () => {
        window.cancelAnimationFrame(frame)
        window.cancelAnimationFrame(innerFrame)
        window.clearTimeout(settleTimer)
      }
    }

    setVisible(false)
    setPhase('exiting')
    timer = window.setTimeout(() => setMounted(false), exitMs)
    return () => window.clearTimeout(timer)
  }, [exitMs, show])

  if (!mounted) return null
  return (
    <div className={`presence-layer presence-${phase} ${visible ? 'visible' : ''} ${className}`.trim()}>
      {children}
    </div>
  )
}


export type DismissEventName = 'pointerdown' | 'click'


export function useDismissOnOutside(
  active: boolean,
  refs: Array<RefObject<HTMLElement>>,
  onDismiss: () => void,
  eventName: DismissEventName = 'pointerdown',
) {
  const onDismissRef = useRef(onDismiss)
  const refsRef = useRef(refs)
  refsRef.current = refs

  useEffect(() => {
    onDismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    if (!active) return

    const handlePointer = (event: MouseEvent | PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (refsRef.current.some((ref) => ref.current?.contains(target))) return
      if (isTransientTriggerTarget(target)) return
      onDismissRef.current()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismissRef.current()
    }

    window.addEventListener(eventName, handlePointer)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener(eventName, handlePointer)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [active, eventName])
}
