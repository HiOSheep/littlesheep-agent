import { readFile } from 'node:fs/promises'
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
    const styles = await source('../styles.css')
    const resizer = ruleBody(styles, '.workspace-files-navigator-resizer')
    const highlight = ruleBody(styles, '.workspace-files-navigator-resizer::after')

    expect(frame).toContain('role="separator"')
    expect(frame).toContain('onPointerDown={beginResize}')
    expect(frame).toContain("event.key === 'ArrowLeft'")
    expect(interaction).toContain('startWidth - (moveEvent.clientX - startX)')
    expect(interaction).toContain('window.requestAnimationFrame(applyDragFrame)')
    expect(interaction).toContain("context.onCollapse()")
    expect(resizer).toContain('position: absolute')
    expect(resizer).toContain('left: 0')
    expect(resizer).not.toContain('transform')
    expect(highlight).toContain('left: 0')
    expect(highlight).toContain('width: 2px')
  })

  it('commits the flex layout once and animates only compositor properties', async () => {
    const frame = await source('./navigator-frame.tsx')
    const styles = await source('../styles.css')
    const navigator = ruleBody(styles, '.workspace-files-navigator')
    const inner = ruleBody(styles, '.workspace-files-navigator-inner')
    const collapsedInner = ruleBody(
      styles,
      '.workspace-files-navigator.navigator-collapsed .workspace-files-navigator-inner',
    )

    expect(navigator).not.toContain('transition:')
    expect(navigator).not.toMatch(/transition[^;]*(?:width|flex-basis)/u)
    expect(inner).toContain('position: absolute')
    expect(inner).toContain('inset: 0 0 0 auto')
    expect(inner).not.toMatch(/transform|will-change|transition/u)
    expect(collapsedInner).toContain('width: var(--workspace-files-navigator-visual-width, 214px)')
    expect(collapsedInner).not.toContain('transform')
    expect(frame).toContain('new ResizeObserver(rememberExpandedWidth)')
    expect(frame).toContain("style.setProperty('--workspace-files-navigator-visual-width'")
    expect(frame).toContain('const animation = inner.animate(')
    expect(frame).toContain('{ transform: startTransform, opacity: startOpacity }')
    expect(frame).toContain('{ transform: endTransform, opacity: endOpacity }')
    expect(frame).toContain('animation.cancel()')
  })

  it('bypasses transient motion when the OS requests reduced motion', async () => {
    const frame = await source('./navigator-frame.tsx')
    const styles = await source('../styles.css')
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
