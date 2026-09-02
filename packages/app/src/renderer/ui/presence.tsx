// Reusable renderer interaction primitives and icons.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { isTransientTriggerTarget } from './transient'


export type PresencePhase = 'entering' | 'open' | 'exiting'


export function FadePresence({
  show,
  children,
  exitMs = 190,
  className = '',
  enterFrames = 2,
  interactiveDuringExit = false,
  keepMounted = false,
  onExited,
}: {
  show: boolean
  children: ReactNode
  exitMs?: number
  className?: string
  enterFrames?: 0 | 1 | 2
  interactiveDuringExit?: boolean
  keepMounted?: boolean
  onExited?: () => void
}) {
  const [mounted, setMounted] = useState(show)
  const [visible, setVisible] = useState(false)
  const onExitedRef = useRef(onExited)
  onExitedRef.current = onExited
  // A visible layer is not open until its first frame has been committed.
  // Starting persisted overlays in `open` hides the underlying surface while
  // the reveal is still at its zero-radius state, which creates a blank flash.
  const [phase, setPhase] = useState<PresencePhase>(show ? 'entering' : 'exiting')

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
      } else if (enterFrames === 0) {
        setVisible(true)
        settleTimer = window.setTimeout(() => setPhase('open'), exitMs)
      } else if (enterFrames === 1) {
        setVisible(false)
        frame = window.requestAnimationFrame(() => {
          setVisible(true)
          settleTimer = window.setTimeout(() => setPhase('open'), exitMs)
        })
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
    timer = window.setTimeout(() => {
      setMounted(false)
      onExitedRef.current?.()
    }, exitMs)
    return () => window.clearTimeout(timer)
  }, [enterFrames, exitMs, show])

  // Persistent surfaces avoid mounting a large, composited subtree during an
  // interaction. This is especially important for overlays containing
  // backdrop-filter: remounting it while a clip-path starts can flash for one
  // compositor frame in Electron.
  if (!mounted && !keepMounted) return null
  const interactionHidden = !show && !interactiveDuringExit
  const persistentHidden = keepMounted && !mounted && !show
  return (
    <div
      className={`presence-layer presence-${phase} ${visible ? 'visible' : ''} ${persistentHidden ? 'presence-hidden' : ''} ${className}`.trim()}
      aria-hidden={interactionHidden}
      {...(interactionHidden ? { inert: '' } : {})}
    >
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
