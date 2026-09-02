// Shared right-side navigator shell for directory browsing and Git review.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { flushSync } from 'react-dom'
import { WORKSPACE_PANEL_MOTION_MS } from '../app-shell/preferences'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { FolderGlyphIcon } from '../ui/icons'
import {
  COLUMN_RESIZE_END_EVENT,
  WORKSPACE_NAVIGATOR_MOTION_END_EVENT,
  WORKSPACE_NAVIGATOR_MOTION_START_EVENT,
} from '../ui/resize'
import { transientTriggerProps } from '../ui/transient'
import { resolveWorkspaceFileNavigatorLayout } from '../workspace-layout'
import { beginWorkspaceNavigatorResizeInteraction } from './navigator-resize-interaction'

export function WorkspaceNavigatorFrame({
  collapsed,
  width,
  ariaLabel,
  children,
  onCollapsedChange,
  onWidthChange,
  onTipChange,
}: {
  collapsed: boolean
  width: number
  ariaLabel: string
  children: ReactNode
  onCollapsedChange: (collapsed: boolean) => void
  onWidthChange: (width: number) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const toggleLabel = collapsed ? `展开${ariaLabel}` : `折叠${ariaLabel}`
  const navigatorRef = useRef<HTMLElement | null>(null)
  const animationRef = useRef<Animation | null>(null)
  const activeDragCleanupRef = useRef<(() => void) | null>(null)
  const navigatorMotionRef = useRef(false)
  const finalMeasureRef = useRef<(() => void) | null>(null)
  const [availableWidth, setAvailableWidth] = useState(0)
  const layout = useMemo(
    () => resolveWorkspaceFileNavigatorLayout(availableWidth, width),
    [availableWidth, width],
  )
  const navigatorStyle = {
    '--workspace-files-navigator-width': `${layout.width}px`,
  } as CSSProperties

  const rememberExpandedWidth = useCallback(() => {
    const navigator = navigatorRef.current
    if (!navigator) return
    const width = navigator.getBoundingClientRect().width
    if (width <= 0.5) return
    navigator.style.setProperty('--workspace-files-navigator-visual-width', `${width}px`)
  }, [])

  useLayoutEffect(() => {
    const navigator = navigatorRef.current
    if (!navigator || collapsed) return
    rememberExpandedWidth()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(rememberExpandedWidth)
    observer.observe(navigator)
    return () => observer.disconnect()
  }, [collapsed, rememberExpandedWidth])

  useLayoutEffect(() => {
    const parent = navigatorRef.current?.parentElement
    // The ordinary folder navigator is mounted in a narrow shared wrapper
    // while collapsed so its reopen rail can remain visible. Measuring that
    // wrapper would reduce the available width to the rail itself and lock
    // the navigator at zero width when reopening.
    const layoutContainer = parent?.classList.contains('workspace-shared-file-navigator')
      ? parent.parentElement
      : parent
    if (!layoutContainer) return
    const measure = () => {
      // Resizing the outer workspace changes this container every display
      // frame. Deferring the React state update until the pointer is released
      // prevents a complete tree render from competing with the drag.
      // The collapse animation changes several flex dimensions at once. Keep
      // its layout state stable until the compositor animation has completed;
      // otherwise ResizeObserver can schedule React renders mid-transition.
      if (
        document.body.classList.contains('is-resizing-column')
        || navigatorMotionRef.current
      ) return
      const nextWidth = Math.round(layoutContainer.getBoundingClientRect().width)
      if (nextWidth <= 0) return
      setAvailableWidth((current) => current === nextWidth ? current : nextWidth)
    }
    finalMeasureRef.current = measure
    measure()
    const handleColumnResizeEnd = () => {
      window.requestAnimationFrame(measure)
    }
    window.addEventListener(COLUMN_RESIZE_END_EVENT, handleColumnResizeEnd)
    if (typeof ResizeObserver === 'undefined') {
      return () => window.removeEventListener(COLUMN_RESIZE_END_EVENT, handleColumnResizeEnd)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(layoutContainer)
    return () => {
      observer.disconnect()
      window.removeEventListener(COLUMN_RESIZE_END_EVENT, handleColumnResizeEnd)
      if (finalMeasureRef.current === measure) finalMeasureRef.current = null
    }
  }, [])

  useEffect(() => () => {
    animationRef.current?.cancel()
    activeDragCleanupRef.current?.()
    document.body.classList.remove('is-workspace-navigator-motion')
  }, [])

  const finishNavigatorMotion = (navigator: HTMLElement) => {
    navigatorMotionRef.current = false
    navigator.classList.remove('navigator-motion')
    document.body.classList.remove('is-workspace-navigator-motion')
    window.dispatchEvent(new Event(WORKSPACE_NAVIGATOR_MOTION_END_EVENT))
    window.requestAnimationFrame(() => finalMeasureRef.current?.())
  }

  const changeCollapsed = (nextCollapsed: boolean) => {
    if (nextCollapsed === collapsed) return
    const navigator = navigatorRef.current
    const inner = navigator?.querySelector<HTMLElement>('.workspace-files-navigator-inner')
    if (!navigator || !inner) {
      onCollapsedChange(nextCollapsed)
      return
    }

    navigatorMotionRef.current = true
    navigator.classList.add('navigator-motion')
    document.body.classList.add('is-workspace-navigator-motion')
    window.dispatchEvent(new Event(WORKSPACE_NAVIGATOR_MOTION_START_EVENT))
    const runningAnimation = animationRef.current
    const visualStyle = getComputedStyle(inner)
    const visualOpacity = Number.parseFloat(visualStyle.opacity)
    const visualTransform = runningAnimation && visualStyle.transform !== 'none'
      ? visualStyle.transform
      : undefined
    const visualWidth = inner.getBoundingClientRect().width
    runningAnimation?.cancel()
    animationRef.current = null
    if (!collapsed) rememberExpandedWidth()

    flushSync(() => onCollapsedChange(nextCollapsed))

    if (matchMedia('(prefers-reduced-motion: reduce)').matches || typeof inner.animate !== 'function') {
      finishNavigatorMotion(navigator)
      return
    }
    const startOpacity = Number.isFinite(visualOpacity) ? visualOpacity : collapsed ? 0 : 1
    const startTransform = visualTransform
      ?? (collapsed ? `translate3d(${visualWidth}px, 0, 0)` : 'translate3d(0, 0, 0)')
    const endOpacity = nextCollapsed ? 0 : 1
    const endTransform = nextCollapsed
      ? `translate3d(${visualWidth}px, 0, 0)`
      : 'translate3d(0, 0, 0)'
    const remainingDistance = Math.abs(endOpacity - startOpacity)
    if (remainingDistance <= 0.001) {
      finishNavigatorMotion(navigator)
      return
    }

    const animation = inner.animate(
      [
        { transform: startTransform, opacity: startOpacity },
        { transform: endTransform, opacity: endOpacity },
      ],
      {
        duration: Math.max(80, WORKSPACE_PANEL_MOTION_MS * remainingDistance),
        easing: 'cubic-bezier(0.22, 0.72, 0.2, 1)',
      },
    )
    animationRef.current = animation
    void animation.finished.then(() => {
      if (animationRef.current !== animation) return
      animationRef.current = null
      animation.cancel()
      finishNavigatorMotion(navigator)
    }).catch(() => {
      // Fast reverse clicks intentionally cancel the in-flight animation.
    })
  }

  const toggleCollapsed = () => changeCollapsed(!collapsed)

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    animationRef.current?.cancel()
    animationRef.current = null
    const navigator = navigatorRef.current
    if (navigatorMotionRef.current && navigator) finishNavigatorMotion(navigator)
    beginWorkspaceNavigatorResizeInteraction(event, {
      collapsed,
      layout,
      navigatorRef,
      activeDragCleanupRef,
      onCollapse: () => changeCollapsed(true),
      onTipChange: () => onTipChange(null),
      onWidthChange,
    })
  }

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | undefined
    if (event.key === 'ArrowLeft') {
      nextWidth = layout.width + (event.shiftKey ? 32 : 12)
    } else if (event.key === 'ArrowRight') {
      nextWidth = layout.width - (event.shiftKey ? 32 : 12)
    } else if (event.key === 'Home') {
      nextWidth = layout.minWidth
    } else if (event.key === 'End') {
      nextWidth = layout.maxWidth
    }
    if (nextWidth === undefined) return
    event.preventDefault()
    onWidthChange(Math.max(layout.minWidth, Math.min(layout.maxWidth, nextWidth)))
  }

  return (
    <aside
      ref={navigatorRef}
      className={`workspace-files-navigator ${collapsed ? 'navigator-collapsed' : ''}`}
      style={navigatorStyle}
      aria-label={ariaLabel}
      aria-expanded={!collapsed}
    >
      <div
        className="workspace-files-navigator-resizer"
        role="separator"
        aria-label={`调整${ariaLabel}宽度`}
        aria-orientation="vertical"
        aria-valuemin={Math.round(layout.minWidth)}
        aria-valuemax={Math.round(layout.maxWidth)}
        aria-valuenow={Math.round(layout.width)}
        aria-hidden={collapsed}
        {...(collapsed ? { inert: '' } : {})}
        tabIndex={collapsed ? -1 : 0}
        onPointerDown={beginResize}
        onKeyDown={handleResizeKeyDown}
      />
      <button
        {...transientTriggerProps()}
        className="workspace-files-navigator-rail"
        type="button"
        aria-label={toggleLabel}
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
        onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(toggleLabel, event.clientX, event.clientY))}
        onMouseMove={(event) => onTipChange(buildFloatingHelpTip(toggleLabel, event.clientX, event.clientY))}
        onMouseLeave={() => onTipChange(null)}
        onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(toggleLabel, event.currentTarget))}
        onBlur={() => onTipChange(null)}
      >
        <FolderGlyphIcon />
      </button>
      <div
        className="workspace-files-navigator-inner"
        aria-hidden={collapsed}
        {...(collapsed ? { inert: '' } : {})}
      >
        {children}
      </div>
    </aside>
  )
}
