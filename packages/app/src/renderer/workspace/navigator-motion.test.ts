import { readFile } from 'node:fs/promises'
import { readRendererStyleSource } from '../style-source-test-utils'
import { describe, expect, it } from 'vitest'

describe('workspace navigator motion', () => {
  it('shares one motion shell between file browsing and Git review', async () => {
    const fileNavigator = await source('./file-navigator.tsx')
    const reviewTree = await source('./review-tree.tsx')

    expect(fileNavigator).toContain('<WorkspaceNavigatorFrame')
    expect(reviewTree).toContain('<WorkspaceNavigatorFrame')
    expect(fileNavigator).toContain('width={navigatorWidth}')
    expect(reviewTree).toContain('width={navigatorWidth}')
    expect(fileNavigator).toContain('onWidthChange={onNavigatorWidthChange}')
    expect(reviewTree).toContain('onWidthChange={onNavigatorWidthChange}')
  })

  it('uses a compositor-paced inward resize with the right-edge drag direction', async () => {
    const frame = await source('./navigator-frame.tsx')
    const interaction = await source('./navigator-resize-interaction.ts')
    const styles = await readRendererStyleSource()
    const resizer = ruleBody(styles, '.workspace-files-navigator-resizer')
    const highlight = ruleBody(styles, '.workspace-files-navigator-resizer::after')

    expect(frame).toContain('role="separator"')
    expect(frame).toContain('onPointerDown={beginResize}')
    expect(frame).toContain("event.key === 'ArrowLeft'")
    expect(interaction).toContain('startWidth - (moveEvent.clientX - startX)')
    expect(interaction).toContain('window.requestAnimationFrame(applyDragFrame)')
    expect(interaction).toContain("parentElement?.classList.contains('workspace-shared-file-navigator')")
    expect(interaction).toContain("sharedTrack?.style.setProperty('--workspace-files-navigator-width', value)")
    expect(interaction).toContain('setVisualWidth(pendingVisualWidth)')
    expect(interaction).toContain('setVisualWidth(draftWidth)')
    expect(interaction).toContain("context.onCollapse()")
    expect(resizer).toContain('position: absolute')
    expect(resizer).toContain('left: 0')
    expect(resizer).not.toContain('transform')
    expect(highlight).toContain('left: 0')
    expect(highlight).toContain('width: 1px')
  })

  it('animates the navigator track and its contents together', async () => {
    const frame = await source('./navigator-frame.tsx')
    const styles = await readRendererStyleSource()
    const navigator = ruleBody(styles, '.workspace-files-navigator')
    const inner = ruleBody(styles, '.workspace-files-navigator-inner')
    const collapsedInner = ruleBody(
      styles,
      '.workspace-files-navigator.navigator-collapsed .workspace-files-navigator-inner',
    )

    expect(navigator).not.toContain('transition:')
    expect(styles).toMatch(/\.workspace-shared-file-navigator\s*\{[^}]*flex:\s*0 0 var\(--workspace-files-navigator-width\);/u)
    expect(styles).toMatch(/\.workspace-shared-file-navigator:not\(\.inactive\):has\(> \.workspace-files-navigator\.navigator-collapsed\)\s*\{[^}]*flex-basis:\s*var\(--workspace-files-control-rail-width\);/u)
    expect(styles).not.toMatch(/\.workspace-shared-file-navigator\s*\{[^}]*flex:\s*0 0 auto;/u)
    expect(styles).toMatch(/body\.is-resizing-column\s+\.workspace-shared-file-navigator\s*\{[^}]*transition-duration:\s*0ms !important;/u)
    expect(inner).toContain('position: absolute')
    expect(inner).toContain('inset: 0 0 0 auto')
    expect(inner).not.toContain('will-change:')
    expect(collapsedInner).toContain('width: var(--workspace-files-navigator-visual-width, 214px)')
    expect(collapsedInner).not.toContain('transform')
    expect(frame).toContain('new ResizeObserver(rememberExpandedWidth)')
    expect(frame).toContain("style.setProperty('--workspace-files-navigator-visual-width'")
    expect(frame).toContain('const animation = inner.animate(')
    expect(frame).toContain('{ transform: startTransform, opacity: startOpacity }')
    expect(frame).toContain('{ transform: endTransform, opacity: endOpacity }')
    expect(frame).toContain('animation.cancel()')
    expect(frame).toContain('COLUMN_RESIZE_END_EVENT')
    expect(frame).toContain("document.body.classList.contains('is-resizing-column')")
    expect(frame).toContain("navigatorMotionRef.current")
    expect(frame).toContain("navigator.classList.add('navigator-motion')")
    expect(frame).toContain("navigator.classList.remove('navigator-motion')")
    expect(frame).toContain("if (!navigator || !inner)")
    expect(frame).toContain('finalMeasureRef.current?.()')
    expect(frame).toContain('const visualWidth = inner.getBoundingClientRect().width')
    expect(frame).toContain('WORKSPACE_NAVIGATOR_MOTION_START_EVENT')
    expect(frame).toContain('WORKSPACE_NAVIGATOR_MOTION_END_EVENT')
  })

  it('uses the persisted navigator width for the shared track beside file tabs', async () => {
    const panel = await source('./panel.tsx')

    expect(panel).toContain("'--workspace-files-navigator-width': `${fileNavigatorWidth}px`")
    expect(panel).toContain('style={sharedFileNavigatorStyle}')
  })

  it('measures the shared folder navigator against the panel body, not its collapsed control rail', async () => {
    const frame = await source('./navigator-frame.tsx')

    expect(frame).toContain("parent?.classList.contains('workspace-shared-file-navigator')")
    expect(frame).toContain('? parent.parentElement')
    expect(frame).toContain('layoutContainer.getBoundingClientRect().width')
    expect(frame).toContain('observer.observe(layoutContainer)')
    expect(frame).not.toContain('parent.getBoundingClientRect().width')
    expect(frame).not.toContain('observer.observe(parent)')
  })

  it('bypasses transient motion when the OS requests reduced motion', async () => {
    const frame = await source('./navigator-frame.tsx')
    const styles = await readRendererStyleSource()
    expect(frame).toContain("matchMedia('(prefers-reduced-motion: reduce)').matches")
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition-duration:\s*1ms !important;/u,
    )
  })
})

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

function ruleBody(styles: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'u'))
  expect(match, `missing CSS rule: ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}
