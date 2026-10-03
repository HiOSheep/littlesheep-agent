import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import staticIcon from '../../../resources/void-ring/mark.png?url'
import type { VoidRingState } from './void-ring-state'
import { createVoidRingMotion, pointerRelativeToDisc, type VoidRingMode, type VoidRingPointer } from './void-ring-motion'
import { isVoidRingRendererReady, onVoidRingFrame, prepareVoidRingRenderer, renderVoidRing } from './void-ring-renderer'

/**
 * Compiles the shader and uploads the mark while the app is still starting, so the first ring on
 * screen can go live on its first frame.
 */
export function warmVoidRingMotion(): Promise<boolean> {
  return prepareVoidRingRenderer(staticIcon)
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const modeFor = (state: VoidRingState): VoidRingMode => (state === 'static' ? 'rest' : state)

/**
 * The LittleSheep eclipse. The still mark is always painted; while motion is allowed and the ring
 * is on screen, a live canvas over it re-lights the corona each frame. `interactive` makes it a
 * button that notices the pointer, gives under a press and answers a greeting.
 */
export function VoidRing({ state = 'idle', size = 28, interactive = false, className = '' }: {
  state?: VoidRingState
  size?: number
  interactive?: boolean
  className?: string
}) {
  const host = useRef<HTMLSpanElement>(null)
  const body = useRef<HTMLSpanElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const motion = useRef(createVoidRingMotion(modeFor(state)))
  const mode = useRef(modeFor(state))
  const pointer = useRef<VoidRingPointer | null>(null)
  const pressed = useRef(false)
  const attention = useRef(0)
  const [allowed, setAllowed] = useState(() => !prefersReducedMotion() && (typeof document === 'undefined' || !document.hidden))
  const [ready, setReady] = useState(isVoidRingRendererReady)
  const [live, setLive] = useState(false)
  mode.current = modeFor(state)

  // Motion only where someone could see it.
  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)')
    let visible = true
    const update = () => setAllowed(visible && !document.hidden && !preference.matches)
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting)
      update()
    })
    if (host.current) observer.observe(host.current)
    preference.addEventListener('change', update)
    document.addEventListener('visibilitychange', update)
    update()
    return () => {
      observer.disconnect()
      preference.removeEventListener('change', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])

  useEffect(() => {
    if (ready || !allowed) return
    let cancelled = false
    void warmVoidRingMotion().then(ok => { if (!cancelled && ok) setReady(true) })
    return () => { cancelled = true }
  }, [ready, allowed])

  // A resting ring that has already settled has nothing to animate until its state changes.
  const [restingSettled, setRestingSettled] = useState(false)
  useEffect(() => { setRestingSettled(false) }, [state])
  const running = allowed && ready && !restingSettled

  // A layout effect, so a renderer that is already warm draws frame 0 (identical to the still mark)
  // before the browser paints: a new conversation never waits on the PNG loading (reported
  // 2026-10-03), and going live is invisible.
  useLayoutEffect(() => {
    const target = canvas.current
    const context = target?.getContext('2d')
    if (!running || !target || !context) return
    // Supersample the shader's thin rim before the browser reduces it to the
    // displayed size. Device resolution alone leaves small rings visibly jagged.
    const ratio = Math.min(4, Math.max(2, (window.devicePixelRatio || 1) * 2))
    target.width = target.height = Math.round(size * ratio)
    const model = motion.current
    model.reset(mode.current)
    const input = () => ({ mode: mode.current, pointer: pointer.current, pressed: pressed.current, attention: attention.current })
    let first = !renderVoidRing(context, model.step(0, input()))
    if (!first) { host.current?.setAttribute('data-motion', 'playing'); setLive(true) }
    const stop = onVoidRingFrame((dt) => {
      const frame = model.step(dt, input())
      if (!renderVoidRing(context, frame)) return
      if (body.current) {
        body.current.style.transform = `translate(${frame.leanX.toFixed(2)}px, ${frame.leanY.toFixed(2)}px) scale(${frame.press.toFixed(4)})`
      }
      if (first) { first = false; setLive(true) }
      if (mode.current === 'rest' && model.settled()) setRestingSettled(true)
    })
    return () => {
      stop()
      setLive(false)
      body.current?.style.removeProperty('transform')
    }
  }, [running, size])

  // Interaction: the ring notices the pointer anywhere nearby, not only on top of it.
  useEffect(() => {
    if (!interactive || !running) return
    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerType === 'touch' || !host.current) return
      pointer.current = pointerRelativeToDisc(host.current.getBoundingClientRect(), event.clientX, event.clientY)
    }
    const leave = () => { pointer.current = null }
    const release = () => { pressed.current = false }
    window.addEventListener('pointermove', move, { passive: true })
    document.documentElement.addEventListener('pointerleave', leave)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    window.addEventListener('blur', leave)
    return () => {
      window.removeEventListener('pointermove', move)
      document.documentElement.removeEventListener('pointerleave', leave)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      window.removeEventListener('blur', leave)
      pointer.current = null
      pressed.current = false
    }
  }, [interactive, running])

  const playing = running && live
  const visual = (
    <span ref={host} className={`void-ring ${className}`} data-void-ring-state={state}
      data-motion={playing ? 'playing' : 'still'} style={{ width: size, height: size }} aria-hidden="true">
      <img className="void-ring-still" src={staticIcon} width={size} height={size} alt="" draggable={false} />
      {running && <canvas ref={canvas} className="void-ring-live" style={{ width: size, height: size }} />}
    </span>
  )
  if (!interactive) return visual

  const press = (down: boolean) => { if (playing) pressed.current = down }
  return (
    <button type="button" className="void-ring-companion" data-motion={playing ? 'playing' : 'still'}
      aria-label="和小羊打个招呼" title="和小羊打个招呼"
      onPointerDown={(event: PointerEvent<HTMLButtonElement>) => { if (event.button === 0) press(true) }}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => { if (event.key === ' ' && !event.repeat) press(true) }}
      onKeyUp={(event: KeyboardEvent<HTMLButtonElement>) => { if (event.key === ' ') press(false) }}
      onFocus={(event) => { attention.current = event.currentTarget.matches(':focus-visible') ? 1 : 0 }}
      onBlur={() => { attention.current = 0; pressed.current = false }}
      onClick={() => { if (playing) motion.current.greet() }}>
      <span ref={body} className="void-ring-body">{visual}</span>
    </button>
  )
}
