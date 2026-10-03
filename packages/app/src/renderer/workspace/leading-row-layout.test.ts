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
    expect(body).toContain('--workspace-files-control-gap: 6px')
    expect(body).toMatch(/--workspace-files-content-reserve:\s*calc\(\s*var\(--workspace-panel-close-line\) \+\s*var\(--workspace-files-control-size\) \/ 2 \+\s*var\(--workspace-files-control-gap\) -\s*var\(--workspace-page-inline-inset\)\s*\)/u)
    expect(body).not.toContain('--workspace-files-navigator-collapsed-width')
    expect(body).toMatch(/--workspace-page-leading-row-height:\s*calc\(\s*var\(--workspace-files-control-top\) \+\s*var\(--workspace-files-control-size\) \+\s*var\(--workspace-files-control-top\)\s*\)/u)
    expect(body).not.toContain('padding-top:')
    expect(leadingRow).toContain('height: var(--workspace-page-leading-row-height)')
    expect(leadingRow).toContain('min-height: var(--workspace-page-leading-row-height)')
    expect(leadingRow).toContain('padding-inline: var(--workspace-page-inline-inset)')
    expect(leadingRow).toContain('padding-block: 0')
    expect(navigatorControl).toContain('top: var(--workspace-files-control-top, 5px)')
    // The rail is centred on the window's close line, less its own column inset (asked for 2026-10-03).
    expect(navigatorControl).toContain('--workspace-panel-close-line')
    expect(navigatorControl).toContain('var(--workspace-files-control-size, 25px) / 2')
    expect(navigatorControl).toContain('height: var(--workspace-files-control-size, 25px)')
  })

  it('names the workspace root by its path alone', async () => {
    const source = await readFile(new URL('./file-navigator.tsx', import.meta.url), 'utf8')

    // The short folder name above the path, and the "当前工作区" badge beside it, repeated what the
    // path already said (asked for 2026-10-03). The temporary root keeps its badge: that one is a
    // state warning, not a label.
    expect(source).toContain('<small>{usingTemporaryRoot ? `来源不改变当前工作区：${defaultWorkspacePath}` : workspacePath}</small>')
    expect(source).toContain('{usingTemporaryRoot && (')
    expect(source).toContain('<b className="workspace-root-badge temporary">临时预览</b>')
    expect(source).not.toContain('当前工作区</b>')
    expect(source).not.toContain('{compactPath(workspacePath)}')
    expect(source).toContain("import { isPathInsideOrSameClient, workspaceAncestorPaths } from './path-utils'")
  })

  it('uses the shared leading row on every workspace page with a first-line toolbar', async () => {
    const expectedClasses = new Map([
      ['./browser.tsx', 'workspace-browser-toolbar workspace-page-leading-row'],
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
    // The row keeps no trailing inset of its own: the buttons stop clear of the navigator's rail,
    // which is the control that owns the window's close line (asked for 2026-10-03).
    expect(ruleBody('.workspace-preview-header')).not.toContain('padding-right:')
    expect(ruleBody('.workspace-review-diff-header')).not.toContain('padding-right:')
    expect(styles).not.toContain('padding-right: 34px')
  })

  it('opens the workspace on its navigation page', async () => {
    const panel = await readFile(new URL('./panel.tsx', import.meta.url), 'utf8')
    const launcher = await readFile(new URL('./empty-launcher.tsx', import.meta.url), 'utf8')
    const persistence = await readFile(new URL('../workspace-persistence.ts', import.meta.url), 'utf8')
    const preferences = await readFile(new URL('../app-shell/preferences.ts', import.meta.url), 'utf8')

    expect(persistence).toContain('export const DEFAULT_WORKSPACE_PANEL_TABS: WorkspacePanelTabId[] = []')
    expect(preferences).not.toContain("return 'home'")
    expect(panel).not.toContain("{ id: 'home', label: '开始'")
    expect(panel).toContain('const launcherEntries = workspaceEntries')
    expect(panel.split('<WorkspaceEmptyLauncher').length - 1).toBe(1)
    // Two lines per entry: where it goes, then what it is.
    expect(launcher).toContain('className="workspace-empty-launcher-label"')
    expect(launcher).toContain('className="workspace-empty-launcher-desc"')
    expect(styles).toMatch(/\.workspace-empty-launcher-desc\s*\{[^}]*font-size:\s*12px;/u)
  })

  it('draws the file preview boundaries as real borders', () => {
    // The header's separator used to be an inset box-shadow - a drawn line that does not belong to the
    // box - and the column beside the preview dropped its left border, so the preview had no real right
    // boundary (asked for 2026-10-03).
    expect(styles).toMatch(/\.workspace-preview-header,\s*\.workspace-files-toolbar\s*\{[^}]*border-bottom:\s*1px solid var\(--border\);/u)
    expect(styles).not.toMatch(/\.workspace-preview-header\s*\{[^}]*box-shadow:/u)
    expect(styles).toMatch(/\.workspace-shared-file-navigator > \.workspace-files-navigator\s*\{[^}]*border-left: 1px solid var\(--border\);/u)
  })

  it('keeps the navigator rail on one line in every tab', async () => {
    const panel = await readFile(new URL('./panel.tsx', import.meta.url), 'utf8')

    // The rail is the folder handle that marks the file column's collapse line. It is measured from the
    // panel's right edge, so every tab that shows that column has to be edge-to-edge: the 文件 tab
    // (`artifacts`) was missing from this list and its rail sat 12px further left than the others
    // (reported 2026-10-03).
    expect(panel).toContain("const usesEdgeToEdgeFileSurface = Boolean(activeFileTab) || activeTab === 'review' || activeTab === 'artifacts'")
    expect(styles).toMatch(/\.workspace-panel-view:has\(> \.workspace-files-tab-navigator\),\s*\.workspace-panel-view:has\(> \.workspace-files\),\s*\.workspace-panel-view:has\(> \.workspace-preview-pane\)\s*\{[^}]*overflow:\s*hidden;[^}]*scrollbar-gutter:\s*auto;[^}]*scrollbar-width:\s*none;/u)
  })

  it('pins the add control with the window controls, outside the scrolling tabs', async () => {
    const panel = await readFile(new URL('./panel.tsx', import.meta.url), 'utf8')
    const strip = await readFile(new URL('./tab-strip.tsx', import.meta.url), 'utf8')

    // The add control used to be the strip's last child, so a tab list wider than the panel scrolled
    // it out of reach (reported 2026-10-03). It now sits in the header's fixed control cluster, in
    // front of the window controls, and the strip only renders tabs.
    expect(strip).not.toContain('<WorkspaceAddMenu')
    expect(strip).not.toContain("from './add-menu'")
    expect(panel).toMatch(/workspace-panel-actions workspace-tab-row-control[\s\S]{0,700}<WorkspaceAddMenu/u)
    expect(panel).toContain('openTabs={openTabs.filter(isWorkspacePanelTab)}')
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
    expect(styles).toMatch(/\.workspace-preview-header,\s*\.workspace-files-toolbar\s*\{[^}]*border-bottom:\s*1px solid var\(--border\);/u)
    expect(editorBody).toContain('padding: 0')
    expect(editorBody).toContain('scrollbar-gutter: auto')
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
    // The navigator's contents are absolute; without a definite wrapper height
    // this standalone tab collapses and clipping hides the complete file tree.
    expect(ruleBody('.workspace-files-tab-navigator')).toContain('height: 100%')
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
    expect(fileSurfaceBody).toMatch(/margin:\s*var\(--workspace-panel-body-gap\)\s*-12px\s*-12px\s*calc\(0px - var\(--workspace-tab-row-inset\)\)/u)
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
    expect(styles).not.toContain('margin-right: var(--workspace-files-content-reserve)')
  })

  it('lets embedded documents own scrolling without a second inset frame', () => {
    const embeddedBody = ruleBody('.workspace-preview-body:has(> .workspace-preview-html-shell),\n.workspace-preview-body:has(> .workspace-preview-html-live),\n.workspace-preview-body:has(> .workspace-preview-pdf)')
    expect(embeddedBody).toContain('padding: 0')
    expect(embeddedBody).toContain('scrollbar-gutter: auto')
    expect(embeddedBody).toContain('overflow: hidden')
    for (const selector of ['.workspace-preview-html-shell', '.workspace-preview-pdf']) {
      expect(ruleBody(selector)).toContain('border: 0')
      expect(ruleBody(selector)).toContain('border-radius: 0')
      expect(ruleBody(selector)).toContain('min-height: 0')
    }
    for (const selector of ['.workspace-preview-html', '.workspace-preview-html-live']) {
      expect(ruleBody(selector)).toContain('min-height: 0')
      expect(ruleBody(selector)).toContain('height: 100%')
    }
  })

  it('puts the panel header controls on the workspace rows\' trailing line', () => {
    // The rows reach the line as the panel's inline inset plus the collapsed reserve (6 + 29), plus
    // the 10px they sit inside the panel body: 45. Measured in the real window, the navigator
    // toolbar's last button, the collapsed navigator's rail, the stationary collapse toggle and the
    // header's window controls all share the window's close line: 23px from the panel's right edge
    // (asked for 2026-10-03).
    expect(ruleBody('.workspace-panel-actions')).toContain('var(--workspace-panel-close-line)')
    expect(styles).not.toContain('--workspace-panel-trailing-inset')
  })

  it('moves the code-wrap strokes into their new shape instead of cross-fading', async () => {
    const toggle = await readFile(new URL('../ui/code-wrap-toggle.tsx', import.meta.url), 'utf8')

    // Every stroke keeps the same path commands in both states (`M H C H`, `M L L`, `M L`), which is
    // what lets `d` interpolate; the stylesheet owns the wrapped values and the transition. Asked for
    // 2026-10-03: the two strokes that differ must travel, not fade.
    expect(toggle).toContain("strokePath('code-wrap-run', 'M2.5 7 H11.5 C11.5 7 13.5 7 13.5 7 C13.5 7 13.5 7 13.5 7 H13.5')")
    expect(toggle).toContain("strokePath('code-wrap-arrow', 'M11.5 5 L13.5 7 L11.5 9')")
    expect(toggle).toContain("strokePath('code-wrap-foot', 'M2.5 11 L5.5 11')")
    expect(toggle).not.toContain('WrapOnIcon')
    expect(toggle).not.toContain('WrapOffIcon')
    expect(styles).toMatch(/\.code-wrap-stroke\s*\{\s*transition:\s*d var\(--motion-base\) var\(--motion-ease\);/u)
    expect(styles).toContain("d: path('M2.5 7 H11.5 C12.6 7 13.5 7.9 13.5 9 C13.5 9.8 12.8 10.5 12 10.5 H8.5')")
    expect(styles).toContain("d: path('M10.5 8.5 L8.5 10.5 L10.5 12.5')")
    expect(styles).not.toContain(".code-wrap-toggle[data-wrapped='true'] .code-wrap-foot")
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
