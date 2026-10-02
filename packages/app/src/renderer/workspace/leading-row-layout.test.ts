import { readFile } from 'node:fs/promises'
import { readRendererStyleSource, readRendererStyleSourceFiles } from '../style-source-test-utils'
import { beforeAll, describe, expect, it } from 'vitest'

let styles = ''

beforeAll(async () => {
  styles = await readRendererStyleSource()
})

function ruleBody(selector: string): string {
  const lineStart = styles.indexOf(`\n${selector} {`)
  const start = lineStart >= 0 ? lineStart + 1 : styles.indexOf(`${selector} {`)
  expect(start, `${selector} rule should exist`).toBeGreaterThanOrEqual(0)
  const end = styles.indexOf('\n}', start)
  expect(end, `${selector} rule should close`).toBeGreaterThan(start)
  return styles.slice(start, end)
}

describe('workspace page leading row alignment', () => {
  it('derives every page leading row from the fixed file navigator control center', () => {
    const body = ruleBody('.workspace-panel-body')
    const leadingRow = ruleBody('.workspace-page-leading-row')
    const navigatorControl = ruleBody('.workspace-files-navigator-rail')

    expect(body).toContain('--workspace-files-control-size: 25px')
    expect(body).toContain('--workspace-files-control-top: 5px')
    expect(body).toContain('--workspace-page-inline-inset: 6px')
    expect(body).toContain('--workspace-files-navigator-width: 214px')
    expect(body).toMatch(/--workspace-files-content-reserve:\s*calc\(\s*var\(--workspace-files-control-size\) \+\s*var\(--workspace-files-control-gap\)\s*\)/u)
    expect(body).not.toContain('--workspace-files-navigator-collapsed-width')
    expect(body).toMatch(/--workspace-page-leading-row-height:\s*calc\(\s*var\(--workspace-files-control-top\) \+\s*var\(--workspace-files-control-size\) \+\s*var\(--workspace-files-control-top\)\s*\)/u)
    expect(body).not.toContain('padding-top:')
    expect(leadingRow).toContain('height: var(--workspace-page-leading-row-height)')
    expect(leadingRow).toContain('min-height: var(--workspace-page-leading-row-height)')
    expect(leadingRow).toContain('padding-inline: var(--workspace-page-inline-inset)')
    expect(leadingRow).toContain('padding-block: 0')
    expect(navigatorControl).toContain('top: var(--workspace-files-control-top, 5px)')
    expect(navigatorControl).toContain('right: var(--workspace-files-control-edge, 6px)')
    expect(navigatorControl).toContain('height: var(--workspace-files-control-size, 25px)')
  })

  it('uses the shared leading row on every workspace page with a first-line toolbar', async () => {
    const expectedClasses = new Map([
      ['./browser.tsx', 'workspace-browser-toolbar workspace-page-leading-row'],
      ['./terminal.tsx', 'workspace-terminal-header workspace-page-leading-row'],
      ['./preview-pane.tsx', 'workspace-preview-header workspace-page-leading-row'],
      ['./review-diff.tsx', 'workspace-review-diff-header workspace-page-leading-row'],
      ['./file-navigator.tsx', 'workspace-files-toolbar workspace-page-leading-row'],
    ])

    await Promise.all([...expectedClasses].map(async ([path, className]) => {
      const source = await readFile(new URL(path, import.meta.url), 'utf8')
      expect(source, path).toContain(`className="${className}"`)
    }))
  })

  it('keeps page-specific rules horizontal and removes obsolete vertical compensation', () => {
    for (const selector of [
      '.workspace-browser-toolbar',
      '.workspace-files-toolbar,\n.workspace-preview-header',
      '.workspace-terminal-header',
    ]) {
      const rule = ruleBody(selector)
      expect(rule, selector).not.toContain('min-height:')
      expect(rule, selector).not.toContain('padding-inline:')
      expect(rule, selector).not.toMatch(/padding(?:-top|-bottom)?:/u)
    }

    expect(ruleBody('.workspace-files-actions')).not.toContain('align-self:')
    expect(ruleBody('.workspace-preview-actions')).not.toContain('align-self:')
    expect(ruleBody('.workspace-files > .workspace-preview-pane')).toContain('flex: 1 1 0')
    expect(ruleBody('.workspace-review-content')).toContain('flex: 1 1 0')
    expect(ruleBody('.workspace-files-navigator.navigator-collapsed')).toContain('overflow: visible')
    expect(ruleBody('.workspace-files-navigator.navigator-collapsed')).toContain('border-left: 0')
    expect(ruleBody('.workspace-files')).not.toContain('--workspace-files-control-')
    expect(styles).not.toContain('.workspace-panel-view.with-file-navigator')
    expect(styles).not.toContain('.workspace-files.navigator-collapsed .workspace-files-navigator')
    expect(ruleBody('.workspace-preview-header')).not.toContain('padding-right:')
    expect(ruleBody('.workspace-review-diff-header')).not.toContain('padding-right:')
    expect(styles).not.toContain('padding-right: 34px')
  })

  it('uses one compact file-preview surface with the path as its only metadata', async () => {
    const previewPane = await readFile(new URL('./preview-pane.tsx', import.meta.url), 'utf8')
    const breadcrumbs = await readFile(new URL('./preview-breadcrumbs.tsx', import.meta.url), 'utf8')
    const editorBody = ruleBody('.workspace-preview-body.editor')

    expect(previewPane).not.toContain('workspace-preview-title')
    expect(previewPane).not.toContain('workspace-preview-editor-badge')
    expect(previewPane).not.toContain('workspace-preview-meta')
    expect(previewPane).not.toContain('workspace-editor-shell')
    expect(previewPane).not.toContain('detectEditorEol')
    expect(previewPane).not.toContain('formatFileSize')
    expect(previewPane).not.toContain('utf8ByteLength')
    expect(previewPane).toContain('<WorkspacePreviewBreadcrumbs')
    expect(breadcrumbs).toContain('className="workspace-preview-breadcrumbs"')
    // The bottom metadata row (type · lines · modified) was redundant next to the breadcrumb and the
    // file itself: removed 2026-10-02, markup and styles together.
    expect(previewPane).not.toContain('workspace-preview-statusbar')
    expect(previewPane).not.toContain('const fileTypeLabel')
    expect(previewPane).not.toContain('editorLineCount')
    expect(styles).not.toContain('.workspace-preview-statusbar')
    expect(styles).toMatch(/\.workspace-preview-header\s*\{[^}]*box-shadow:\s*inset 0 -1px var\(--border\);/u)
    expect(editorBody).toContain('padding: 0')
    expect(styles).not.toContain('.workspace-preview-editor-badge')
    expect(styles).not.toContain('.workspace-preview-meta')
    expect(styles).not.toContain('.workspace-editor-shell')
  })

  it('drops the seam and the workspace shorthand inside the 文件 tab only', async () => {
    // The tab is the folder column itself, so it keeps the concrete path but not the seam drawn
    // against a pane it does not have, nor the workspace's shorthand name and badge above a list
    // that already says where it is. The shared column keeps both (reported 2026-10-02).
    expect(styles).toMatch(/\.workspace-files-tab-navigator > \.workspace-files-navigator\s*\{[^}]*border-left:\s*0;/u)
    expect(styles).toMatch(/\.workspace-files-tab-navigator \.workspace-files-root > span\s*\{\s*display:\s*none;\s*\}/u)
    expect(styles).toMatch(/\.workspace-files-navigator\s*\{[^}]*border-left:\s*1px solid var\(--border\);/u)
  })

  it('fills file and review pages without a floating or hover-reactive surface', async () => {
    const panel = await readFile(new URL('./panel.tsx', import.meta.url), 'utf8')
    const reviewSource = await readFile(new URL('./review.tsx', import.meta.url), 'utf8')
    const fileSurfaceBody = ruleBody('.workspace-panel-body.file-surface-active')
    const files = ruleBody('.workspace-files')
    const sharedSurface = ruleBody('.workspace-files-navigator,\n.workspace-preview-pane')
    const navigator = ruleBody('.workspace-files-navigator')
    const navigatorInner = ruleBody('.workspace-files-navigator-inner')
    const review = ruleBody('.workspace-review-diff')

    expect(panel).toContain("const usesEdgeToEdgeFileSurface = Boolean(activeFileTab) || activeTab === 'review'")
    expect(panel).toContain("usesEdgeToEdgeFileSurface ? 'file-surface-active' : ''")
    expect(panel).toContain('className={`workspace-panel-view workspace-tab-view ${isActive ? \'active content-fade\' : \'cached\'}`}')
    expect(panel).toContain("{...(!isActive ? { inert: '' } : {})}")
    expect(panel).not.toContain('with-file-navigator')
    expect(reviewSource).toMatch(/<div className=\{`workspace-review workspace-files \$\{sideBySide \? 'is-side-by-side' : ''\}`\}>/u)
    expect(reviewSource).not.toContain("'navigator-collapsed'")
    expect(fileSurfaceBody).toMatch(/margin:\s*8px\s*-12px\s*-12px\s*calc\(0px - var\(--workspace-tab-row-inset\)\)/u)
    expect(files).toContain('display: flex')
    expect(files).toContain('width: 100%')
    expect(sharedSurface).not.toContain('border:')
    expect(sharedSurface).not.toContain('border-radius:')
    expect(sharedSurface).not.toContain('transition:')
    expect(navigator).toContain('position: absolute')
    expect(navigator).toContain('width: var(--workspace-files-navigator-width)')
    expect(navigator).toContain('background: transparent')
    expect(navigatorInner).toContain('background: transparent')
    expect(navigator).toContain('border-left: 1px solid var(--border)')
    expect(navigator).not.toMatch(/transition:[\s\S]*flex-basis/u)
    expect(navigator).not.toMatch(/(?:top|right|bottom):/u)
    expect(navigator).not.toContain('box-shadow:')
    expect(review).not.toContain('border:')
    expect(review).not.toContain('border-radius:')
    expect(review).not.toContain('transition:')
    expect(styles).not.toContain('.workspace-preview-pane:hover')
    expect(styles).not.toContain('.workspace-review-diff:hover')
    expect(styles).not.toContain('.workspace-files-tree')
    expect(styles).not.toContain('.workspace-review > .workspace-files-navigator')
    expect(styles).not.toContain('--workspace-files-surface-border-width')
  })

  it('keeps the panel seam above the surface that reaches its outer edge', async () => {
    // The file surface above cancels the contents' left padding, so its opaque fill reaches the
    // panel's outer edge. The seam against the chat column therefore has to be painted on a layer
    // that outranks the contents: as a `box-shadow` on the surface it was covered, and on
    // 2026-10-01 the divider disappeared for every file and review tab while the two columns read
    // as one. Both halves of that causal pair are asserted, so neither can drift alone.
    const fileSurfaceBody = ruleBody('.workspace-panel-body.file-surface-active')
    const contents = ruleBody('.workspace-panel-contents')
    const seam = ruleBody('.workspace-panel-surface::after')
    const files = await readRendererStyleSourceFiles()
    const windowLayout = files.find((file) => file.path === './styles/14-window-layout.css')?.source ?? ''
    const surfaceStart = windowLayout.indexOf('.workspace-panel-surface {')
    const surface = windowLayout.slice(surfaceStart, windowLayout.indexOf('\n}', surfaceStart))

    expect(fileSurfaceBody).toContain('calc(0px - var(--workspace-tab-row-inset))')
    expect(contents).toContain('z-index: 1')
    expect(seam).toContain('position: absolute')
    expect(seam).toContain('border-left: 1px solid var(--border)')
    expect(seam).toContain('pointer-events: none')
    expect(Number(seam.match(/z-index:\s*(\d+)/u)?.[1] ?? 0)).toBeGreaterThan(1)
    // Nothing paints the seam on the surface itself any more, where a child could cover it.
    expect(surfaceStart).toBeGreaterThanOrEqual(0)
    expect(surface).not.toContain('box-shadow:')
  })

  it('lets file content reach the right edge while the navigator is collapsed', () => {
    const collapsedNavigator = ruleBody('.workspace-files-navigator.navigator-collapsed')
    const sharedNavigator = ruleBody('.workspace-shared-file-navigator')
    const sharedCollapsedRail = ruleBody(
      '.workspace-shared-file-navigator:not(.inactive):has(> .workspace-files-navigator.navigator-collapsed)',
    )
    const collapsedTopRowReserve = ruleBody(
      '.workspace-files:has(> .workspace-files-navigator.navigator-collapsed) > .workspace-preview-pane .workspace-page-leading-row,\n.workspace-files:has(> .workspace-files-navigator.navigator-collapsed) > .workspace-review-content .workspace-page-leading-row,\n.workspace-panel-body:has(> .workspace-shared-file-navigator:not(.inactive) > .workspace-files-navigator.navigator-collapsed)\n  > .workspace-panel-view.active .workspace-page-leading-row',
    )

    expect(collapsedNavigator).toContain('overflow: visible')
    expect(collapsedNavigator).toContain('border-left: 0')
    expect(sharedNavigator).toContain('overflow: visible')
    expect(sharedNavigator).toContain('position: relative')
    expect(sharedNavigator).toContain('z-index: 6')
    expect(sharedCollapsedRail).toContain('flex-basis: var(--workspace-files-control-rail-width)')
    expect(sharedCollapsedRail).toContain('margin-left: calc(0px - var(--workspace-files-control-rail-width))')
    expect(collapsedTopRowReserve).toContain(
      'var(--workspace-page-inline-inset) +\n    var(--workspace-files-content-reserve)',
    )
    expect(styles).not.toContain('--workspace-files-navigator-collapsed-width')
  })

  it('uses the collapsed navigator rail as one safe right-side track on every page header', () => {
    const collapsedTopRowReserve = ruleBody(
      '.workspace-files:has(> .workspace-files-navigator.navigator-collapsed) > .workspace-preview-pane .workspace-page-leading-row,\n.workspace-files:has(> .workspace-files-navigator.navigator-collapsed) > .workspace-review-content .workspace-page-leading-row,\n.workspace-panel-body:has(> .workspace-shared-file-navigator:not(.inactive) > .workspace-files-navigator.navigator-collapsed)\n  > .workspace-panel-view.active .workspace-page-leading-row',
    )

    expect(collapsedTopRowReserve).toContain('padding-right: calc(')
    expect(collapsedTopRowReserve).toContain('var(--workspace-page-inline-inset)')
    expect(collapsedTopRowReserve).toContain('var(--workspace-files-content-reserve)')
    expect(styles).toContain('> .workspace-panel-view.active .workspace-page-leading-row')
  })

  it('keeps top-row button groups on the shared control gap', () => {
    expect(ruleBody('.workspace-browser-nav')).toContain('gap: var(--workspace-files-control-gap, 4px)')
    expect(ruleBody('.workspace-files-actions')).toContain('gap: var(--workspace-files-control-gap, 4px)')
    expect(ruleBody('.workspace-preview-actions')).toContain('gap: var(--workspace-files-control-gap, 4px)')
    expect(ruleBody('.workspace-terminal-actions')).toContain('gap: var(--workspace-files-control-gap, 4px)')
    expect(ruleBody('.workspace-review-diff-actions')).toContain('gap: var(--workspace-files-control-gap, 4px)')
    expect(styles).not.toMatch(/@container\s*\(max-width:\s*410px\)[\s\S]*?\.workspace-review-diff-actions\s*\{[\s\S]*?gap:/u)
  })

  it('keeps preview toolbar hover surfaces free of edge lines', () => {
    const iconButton = ruleBody('.workspace-files-icon-btn')
    // The pressed state shares the hover surface, so the toggle that keeps a
    // wrap preference shows the same borderless treatment as hover and focus.
    const iconButtonHover = ruleBody(
      '.workspace-files-icon-btn:hover,\n.workspace-files-icon-btn:focus-visible,\n.workspace-files-icon-btn[aria-pressed="true"]',
    )
    const textButton = ruleBody('.workspace-files-text-btn')
    const textButtonHover = ruleBody('.workspace-files-text-btn:hover,\n.workspace-files-text-btn:focus-visible,\n.workspace-files-text-btn.active')

    expect(iconButton).toContain('border: 0')
    expect(iconButton).not.toContain('border-color')
    expect(iconButtonHover).toContain('outline: 0')
    expect(textButton).toContain('border: 0')
    expect(textButton).not.toContain('border-color')
    expect(textButtonHover).toContain('outline: 0')
  })

  it('keeps file tree hover and selection surfaces borderless without shifting their contents', () => {
    const treeRow = ruleBody('.workspace-tree-row')
    const treeRowInteraction = ruleBody(
      '.workspace-tree-row:hover,\n.workspace-tree-row:focus-visible,\n.workspace-tree-row.selected',
    )

    expect(treeRow).toContain('padding: 0 7px 0 calc(var(--workspace-tree-row-inline-start, 5px) + var(--workspace-tree-indent))')
    expect(treeRow).toContain('border: 0')
    expect(treeRow).not.toContain('border-color')
    expect(treeRowInteraction).not.toContain('border')
    expect(treeRowInteraction).toContain('background: var(--workspace-tree-interaction-hover)')
    expect([...styles.matchAll(/\.workspace-tree-row\.selected\s*\{([^}]*)\}/gu)].some(
      (match) => match[1]?.includes('background: var(--workspace-tree-interaction-active)'),
    )).toBe(true)
    expect(styles).toContain('--workspace-tree-interaction-hover: color-mix(in srgb, var(--control-hover) 66%, transparent)')
    expect(styles).toContain('--workspace-tree-interaction-active: color-mix(in srgb, var(--control-active) 68%, transparent)')
  })

  it('draws depth guides only through expanded file-tree branches', async () => {
    const fileNavigator = await readFile(new URL('./workspace-tree-rows.tsx', import.meta.url), 'utf8')
    const treeEntry = ruleBody('.workspace-tree-entry')
    const expandedTreeEntry = ruleBody(
      '.workspace-tree-entry.expanded::before,\n.workspace-review-tree-branch.expanded::before',
    )

    expect(fileNavigator).toContain('workspace-tree-entry')
    expect(fileNavigator).toContain("'--workspace-tree-depth': depth")
    expect(await readFile(new URL('./review-tree.tsx', import.meta.url), 'utf8')).toContain(
      "'--workspace-tree-depth': depth",
    )
    expect(treeEntry).toContain('position: relative')
    expect(treeEntry).toContain('--workspace-tree-indent-step: 16px')
    expect(ruleBody('.workspace-review-tree-branch')).toContain('--workspace-tree-indent-step: 16px')
    expect(expandedTreeEntry).toContain('top: var(--workspace-tree-row-height)')
    expect(expandedTreeEntry).toContain('bottom: 0')
    expect(expandedTreeEntry).toContain('left: calc(')
    expect(expandedTreeEntry).toContain('var(--workspace-tree-row-inline-start)')
    expect(expandedTreeEntry).toContain('(var(--workspace-tree-depth, 0) * var(--workspace-tree-indent-step))')
    expect(expandedTreeEntry).not.toContain('var(--workspace-tree-depth, 0) + 1')
    expect(expandedTreeEntry).toContain('var(--workspace-tree-indent-step)')
    expect(expandedTreeEntry).toContain('var(--workspace-tree-guide-offset)')
    expect(expandedTreeEntry).toContain('width: var(--workspace-tree-guide-width)')
    expect(expandedTreeEntry).toContain('z-index: 0')
    expect(expandedTreeEntry).toContain('background-color: var(--border)')
    expect(expandedTreeEntry).toContain('pointer-events: none')
    expect(ruleBody('.workspace-tree-row')).toContain(
      'var(--workspace-tree-indent-step, 16px)',
    )
    expect(ruleBody('.workspace-tree-notice')).toContain(
      'var(--workspace-tree-indent-step, 16px)',
    )
  })

  it('keeps the file tree viewport geometry stable while folders open', () => {
    const tree = ruleBody('.workspace-tree')

    expect(tree).toContain('overflow-anchor: none')
    expect(tree).toContain('scrollbar-gutter: stable')
  })
})
