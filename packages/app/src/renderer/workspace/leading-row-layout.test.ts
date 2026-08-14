import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'

let styles = ''

beforeAll(async () => {
  styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')
})

function ruleBody(selector: string): string {
  const start = styles.indexOf(`${selector} {`)
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
    expect(body).toContain('--workspace-files-surface-border-width: 1px')
    expect(body).toMatch(/--workspace-files-content-reserve:\s*calc\(\s*var\(--workspace-files-control-size\) \+\s*var\(--workspace-files-control-gap\)\s*\)/u)
    expect(body).toMatch(/--workspace-files-navigator-collapsed-width:\s*calc\(\s*var\(--workspace-files-control-size\) \+\s*var\(--workspace-files-control-edge\) \+\s*var\(--workspace-files-control-edge\)\s*\)/u)
    expect(body).toMatch(/--workspace-page-leading-row-height:\s*calc\(\s*var\(--workspace-files-control-top\) \+\s*var\(--workspace-files-control-size\) \+\s*var\(--workspace-files-control-top\)\s*\)/u)
    expect(body).not.toContain('padding-top:')
    expect(leadingRow).toContain('height: var(--workspace-page-leading-row-height)')
    expect(leadingRow).toContain('min-height: var(--workspace-page-leading-row-height)')
    expect(leadingRow).toContain('padding-inline: var(--workspace-page-inline-inset)')
    expect(leadingRow).toContain('padding-block: 0')
    expect(navigatorControl).toContain('top: var(--workspace-files-control-top, 5px)')
    expect(navigatorControl).toMatch(/right:\s*calc\(\s*var\(--workspace-files-control-edge, 6px\) -\s*var\(--workspace-files-surface-border-width, 1px\)\s*\)/u)
    expect(navigatorControl).toContain('height: var(--workspace-files-control-size, 25px)')
  })

  it('uses the shared leading row on every workspace page with a first-line toolbar', async () => {
    const expectedClasses = new Map([
      ['./browser.tsx', 'workspace-browser-toolbar workspace-page-leading-row'],
      ['./artifacts.tsx', 'workspace-artifacts-header workspace-page-leading-row'],
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
      '.workspace-artifacts-header',
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
    expect(ruleBody('.workspace-panel-view.with-file-navigator')).toContain('padding-right: var(--workspace-files-content-reserve)')
    expect(ruleBody('.workspace-files > .workspace-preview-pane')).not.toContain('padding-right:')
    expect(styles).toMatch(/\.workspace-preview-header\s*\{[^}]*padding-right:\s*calc\(\s*var\(--workspace-page-inline-inset\) \+\s*var\(--workspace-files-content-reserve\)\s*\);/u)
    expect(ruleBody('.workspace-files')).not.toContain('--workspace-files-control-')
    expect(styles).not.toContain('padding-right: 34px')
    expect(styles).toMatch(/\.workspace-files\.navigator-collapsed \.workspace-files-navigator,[\s\S]*?\.workspace-files-navigator\.navigator-collapsed\s*\{[^}]*width:\s*var\(--workspace-files-navigator-collapsed-width, 37px\);/u)
  })

  it('uses one compact file-preview surface with metadata only in the bottom status row', async () => {
    const previewPane = await readFile(new URL('./preview-pane.tsx', import.meta.url), 'utf8')
    const editorBody = ruleBody('.workspace-preview-body.editor')
    const statusbar = ruleBody('.workspace-preview-statusbar')

    expect(previewPane).not.toContain('workspace-preview-title')
    expect(previewPane).not.toContain('workspace-preview-editor-badge')
    expect(previewPane).not.toContain('workspace-preview-meta')
    expect(previewPane).not.toContain('workspace-editor-shell')
    expect(previewPane).toContain('className="workspace-preview-breadcrumbs"')
    expect(previewPane).toContain('className="workspace-preview-statusbar"')
    expect(previewPane).toContain('{previewModifiedAt && <span>{previewModifiedAt}</span>}')
    expect(styles).toMatch(/\.workspace-preview-header\s*\{[^}]*box-shadow:\s*inset 0 -1px var\(--border\);/u)
    expect(editorBody).toContain('padding: 0')
    expect(statusbar).toContain('border-top: 1px solid #303030')
    expect(styles).not.toContain('.workspace-preview-editor-badge')
    expect(styles).not.toContain('.workspace-preview-meta')
    expect(styles).not.toContain('.workspace-editor-shell')
  })
})
