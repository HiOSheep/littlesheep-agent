import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'

let styles = ''

beforeAll(async () => {
  styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8')
})

function ruleBody(selector: string): string {
  const start = styles.indexOf(`${selector} {`)
  expect(start, `${selector} rule should exist`).toBeGreaterThanOrEqual(0)
  const end = styles.indexOf('\n}', start)
  expect(end, `${selector} rule should close`).toBeGreaterThan(start)
  return styles.slice(start, end)
}

describe('frontend font rendering baseline', () => {
  it('does not keep persistent text surfaces in forced 3D compositor layers', () => {
    for (const selector of [
      '.primary-workspace',
      '.settings-workspace',
      '.memory-file-row',
      '.sidebar',
      '.window-shell.sidebar-collapsed .sidebar,\n.window-shell.sidebar-drag-collapsed .sidebar',
      '.sidebar-contents',
      '.settings-sidebar',
      '.window-shell.sidebar-collapsed .settings-sidebar,\n.window-shell.sidebar-drag-collapsed .settings-sidebar',
      '.settings-sidebar-contents',
      '.project-tree',
      '.project-session-list',
      '.session-list',
      '.sidebar-feature-panel',
      '.sidebar-feature-content',
      '.workspace-files-navigator',
      '.workspace-files-navigator-inner',
      '.workspace-add-panel',
      '.add-menu-panel',
      '.workspace-empty-launcher-item',
      '.workspace-tree-row',
      '.message-file-card',
      '.attachment-preview-card',
      '.chat',
      '.window-shell.workspace-panel-fullscreen .chat,\n.window-shell.workspace-panel-drag-fullscreen .chat',
      '.workspace-panel',
      '.workspace-panel-contents',
      '.window-shell.workspace-panel-collapsed .workspace-panel-contents,\n.window-shell.workspace-panel-drag-collapsed .workspace-panel-contents',
      '.workspace-panel-reopen-label',
      '.settings-entry-label',
      '.settings-entry-bridge-label',
      '.task-progress-anchor',
      '.task-progress-popover',
      '.context-usage-popover-shell',
      '.context-usage-popover',
      '.runtime-picker-panel',
      '.runtime-menu-shell',
      '.runtime-menu-shell .runtime-submenu',
      '.model-picker-panel',
      '.floating-help-tip',
      '.presence-layer .dialog',
      '.settings-entry-bridge',
      '.approval-presence .approval-prompt',
      '.project-creator-dialog',
      '.project-create-panel',
      '.is-running',
      '.activity-live',
      '.archive-child-list',
      '.plugin-trust-confirmation',
      '.plugin-list-details',
      '.trace-body',
      '.assistant-turn-process,\n.activity-disclosure-body,\n.activity-command-body',
    ]) {
      const body = ruleBody(selector)
      expect(body).not.toMatch(
        /(?:^|\s)transform\s*:|backface-visibility|will-change\s*:|transition(?:-property)?\s*:[^;]*\btransform\b/u,
      )
    }
  })

  it('does not paint-contain the settings text surfaces', () => {
    for (const selector of ['.settings-workspace-body', '.direct-module-workspace']) {
      expect(ruleBody(selector)).not.toContain('contain: paint')
    }
  })

  it('keeps absolute pixel font sizes on the whole CSS pixel grid', () => {
    expect(styles).not.toMatch(/font-size:\s*\d+\.\d+px/u)
  })

  it('prefers Windows UI-optimized Latin and Chinese fonts', () => {
    expect(styles).toContain('"Segoe UI Variable Text", "Microsoft YaHei UI"')
    expect(ruleBody('body')).toContain('font-synthesis: none')
  })

  it('pixel-aligns centered settings and direct-module text surfaces', () => {
    expect(ruleBody('.settings-workspace-body')).toContain('justify-content: flex-start')
    expect(ruleBody('.direct-module-workspace')).toContain('justify-content: flex-start')
    expect(ruleBody('.settings-page-transition')).toContain('round(nearest')
    expect(ruleBody('.direct-module-page')).toContain('round(nearest')
  })

  it('keeps the shared content entrance animation transform-free', () => {
    expect(ruleBody('@keyframes content-fade-in')).not.toContain('transform:')
  })
})
