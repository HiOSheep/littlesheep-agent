import { useLayoutEffect, useRef, type RefObject } from 'react'
import { WORKSPACE_NAVIGATOR_MOTION_END_EVENT } from '../ui/resize'

export function WorkspaceReviewScrollRail({
  targetRef,
}: {
  targetRef: RefObject<HTMLDivElement>
}) {
  const railRef = useRef<HTMLDivElement>(null)
  const proxyRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    const target = targetRef.current
    const rail = railRef.current
    const proxy = proxyRef.current
    if (!target || !rail || !proxy) return

    const syncRailPosition = () => {
      const nextTop = Math.min(
        target.scrollTop,
        Math.max(0, target.scrollHeight - target.clientHeight),
      )
      if (Math.abs(rail.scrollTop - nextTop) > 0.5) rail.scrollTop = nextTop
    }

    const updateProxySize = () => {
      frameRef.current = null
      proxy.style.height = `${Math.max(target.scrollHeight, target.clientHeight)}px`
      syncRailPosition()
    }

    const scheduleProxySizeUpdate = () => {
      if (document.body.classList.contains('is-workspace-navigator-motion')) return
      if (frameRef.current !== null) return
      frameRef.current = window.requestAnimationFrame(updateProxySize)
    }

    const handleTargetScroll = () => {
      syncRailPosition()
    }

    const handleRailScroll = () => {
      if (Math.abs(target.scrollTop - rail.scrollTop) > 0.5) {
        target.scrollTop = rail.scrollTop
      }
    }

    target.addEventListener('scroll', handleTargetScroll, { passive: true })
    rail.addEventListener('scroll', handleRailScroll, { passive: true })
    window.addEventListener(WORKSPACE_NAVIGATOR_MOTION_END_EVENT, scheduleProxySizeUpdate)
    updateProxySize()

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleProxySizeUpdate)
    resizeObserver?.observe(target)

    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(scheduleProxySizeUpdate)
    mutationObserver?.observe(target, { childList: true, subtree: true })

    return () => {
      target.removeEventListener('scroll', handleTargetScroll)
      rail.removeEventListener('scroll', handleRailScroll)
      window.removeEventListener(WORKSPACE_NAVIGATOR_MOTION_END_EVENT, scheduleProxySizeUpdate)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [targetRef])

  return (
    <div
      ref={railRef}
      className="workspace-review-scroll-rail"
      aria-hidden="true"
    >
      <div ref={proxyRef} />
    </div>
  )
}
