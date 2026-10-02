import { useEffect, useRef, useState } from 'react'
import staticIcon from '../../../resources/void-ring/mark.png?url'
import idle from '../../../resources/void-ring/idle_breath.webp?url'
import loading from '../../../resources/void-ring/loading_orbit.webp?url'
import thinking from '../../../resources/void-ring/thinking_pulse.webp?url'
import type { VoidRingState } from './void-ring-state'

const motion = { idle, loading, thinking }

/** The accepted baked light field; the browser owns timing, not React renders. */
export function VoidRing({ state = 'idle', size = 28, enter = false, className = '' }: {
  state?: VoidRingState
  size?: number
  /** One opening transition when the empty conversation first mounts. */
  enter?: boolean
  className?: string
}) {
  const host = useRef<HTMLSpanElement>(null)
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)')
    let visible = true
    const update = () => setEnabled(visible && !document.hidden && !preference.matches)
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
  const source = enabled && state !== 'static' ? motion[state] : staticIcon
  return (
    <span ref={host} className={`void-ring ${className}`} data-void-ring-state={state}
      data-motion={enabled && state !== 'static' ? 'playing' : 'still'}
      style={{ width: size, height: size }} aria-hidden="true">
      <img src={source} width={size} height={size} alt="" draggable={false} />
      {enter && <img className="void-ring-open" src={staticIcon} width={size} height={size} alt="" draggable={false} />}
    </span>
  )
}
