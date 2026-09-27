import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { readRendererStyleSource } from './style-source-test-utils'

const styles = await readRendererStyleSource()

interface Rule {
  selector: string
  body: string
}

/**
 * Rules declared outside any conditional group. A `@media` / `@container` block legitimately
 * restates a value for another viewport, so it must not count as a duplicate declaration.
 */
function unconditionalRules(source: string): Rule[] {
  let stripped = ''
  let i = 0
  while (i < source.length) {
    const at = source.indexOf('@', i)
    if (at < 0) {
      stripped += source.slice(i)
      break
    }
    const brace = source.indexOf('{', at)
    if (brace < 0) {
      stripped += source.slice(i)
      break
    }
    const head = source.slice(at, brace).trim()
    if (!/^@(?:media|container|supports|layer|scope)\b/u.test(head)) {
      stripped += source.slice(i, brace + 1)
      i = brace + 1
      continue
    }
    let depth = 1
    let j = brace + 1
    while (j < source.length && depth > 0) {
      if (source[j] === '{') depth += 1
      else if (source[j] === '}') depth -= 1
      j += 1
    }
    stripped += source.slice(i, at)
    i = j
  }
  const rules: Rule[] = []
  for (const match of stripped.replaceAll(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selector = (match[1] ?? '').trim()
    if (selector.length > 0) rules.push({ selector, body: match[2] ?? '' })
  }
  return rules
}

const rules = unconditionalRules(styles)

/** Every rule whose selector list contains `selector` as one of its parts, in source order. */
function matchingRules(selector: string): Rule[] {
  return rules.filter((rule) => rule.selector.split(',').some((part) => part.trim() === selector))
}

/** The value that actually applies: the last matching declaration wins within one specificity tier. */
function effective(selector: string, property: string): string | null {
  let value: string | null = null
  for (const rule of matchingRules(selector)) {
    const match = rule.body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'u'))
    if (match) value = (match[1] ?? '').trim()
  }
  return value
}

describe('settings body type scale', () => {
  it('defines the settings type tokens once, beside the shared control tokens', () => {
    const rootStart = styles.indexOf(':root {')
    const root = styles.slice(rootStart, styles.indexOf('\n}', rootStart))

    for (const token of [
      '--settings-page-title-font-size:',
      '--settings-page-desc-font-size:',
      '--settings-group-title-font-size:',
      '--settings-row-title-font-size:',
      '--settings-row-desc-font-size:',
      '--settings-meta-font-size:',
      '--settings-row-min-height:',
      '--settings-switch-width:',
      '--settings-switch-height:',
      '--settings-switch-knob:',
      '--settings-switch-travel:',
    ]) {
      expect(root, token).toContain(token)
    }
  })

  it('resolves every settings text role to a token instead of a literal size', () => {
    // The plugin and model pages used to sit 4-6px below the storage and web pages (10-11px
    // labels next to 15-17px rows), which read as two products inside one settings area.
    const expectations: Array<[string, string]> = [
      ['.settings-module-heading h2', 'var(--settings-page-title-font-size)'],
      ['.settings-home-heading h2', 'var(--settings-page-title-font-size)'],
      ['.settings-module-heading p', 'var(--settings-page-desc-font-size)'],
      ['.settings-home-heading p', 'var(--settings-page-desc-font-size)'],
      ['.settings-overview-group-title', 'var(--settings-group-title-font-size)'],
      ['.storage-settings-heading', 'var(--settings-group-title-font-size)'],
      ['.settings-policy-heading', 'var(--settings-group-title-font-size)'],
      ['.web-settings-heading', 'var(--settings-group-title-font-size)'],
      ['.development-environment-group-title', 'var(--settings-group-title-font-size)'],
      ['.application-background-section-heading', 'var(--settings-group-title-font-size)'],
      ['.storage-settings-row strong', 'var(--settings-row-title-font-size)'],
      ['.web-settings-row strong', 'var(--settings-row-title-font-size)'],
      ['.settings-policy-row strong', 'var(--settings-row-title-font-size)'],
      ['.settings-overview-row strong', 'var(--settings-row-title-font-size)'],
      ['.plugin-list-title strong', 'var(--settings-row-title-font-size)'],
      ['.provider-card-title strong', 'var(--settings-row-title-font-size)'],
      ['.active-run-state strong', 'var(--settings-row-title-font-size)'],
      ['.storage-settings-row small', 'var(--settings-row-desc-font-size)'],
      ['.web-settings-row small', 'var(--settings-row-desc-font-size)'],
      ['.settings-policy-row small', 'var(--settings-row-desc-font-size)'],
      ['.settings-overview-row span', 'var(--settings-row-desc-font-size)'],
      ['.plugin-list-description', 'var(--settings-row-desc-font-size)'],
      ['.provider-editor-key-note', 'var(--settings-row-desc-font-size)'],
      ['.active-run-state small', 'var(--settings-row-desc-font-size)'],
      ['.plugin-list-meta', 'var(--settings-meta-font-size)'],
      ['.plugin-list-error', 'var(--settings-meta-font-size)'],
      ['.plugin-runtime-state', 'var(--settings-meta-font-size)'],
      ['.provider-badge', 'var(--settings-meta-font-size)'],
      ['.provider-model-field-label', 'var(--settings-meta-font-size)'],
      ['.development-environment-status', 'var(--settings-meta-font-size)'],
    ]

    for (const [selector, token] of expectations) {
      expect(effective(selector, 'font-size'), selector).toBe(token)
    }
  })

  it('keeps every settings row on one height', () => {
    // `.settings-overview-row` is deliberately absent: it is the settings home navigation entry
    // (a button with an arrow that opens a page), so it keeps the sidebar interaction frame and
    // its own height rather than the row-card geometry.
    for (const selector of [
      '.storage-settings-row',
      '.web-settings-row',
      '.settings-policy-row',
      '.development-environment-row',
      '.plugin-list-disclosure',
      '.profile-choice-list > .profile-choice',
    ]) {
      expect(effective(selector, 'min-height'), selector).toBe('var(--settings-row-min-height)')
    }
  })

  it('keeps row actions at the shared compact-row height instead of a per-page 42px', () => {
    // The merged rounds told the contract one thing (30px) and the cascade another (42px); the
    // shared-control test could not see it because it only asked whether *some* rule matched.
    for (const selector of [
      '.storage-settings-row button',
      '.storage-settings-actions button',
      '.settings-policy-row button',
    ]) {
      expect(effective(selector, 'min-height'), selector).toBe('var(--control-height-row)')
      expect(effective(selector, 'font-size'), selector).toBe('var(--control-font-size)')
    }
  })

  it('draws one switch geometry for every settings page', () => {
    expect(effective('.plugin-switch', 'width')).toBe('var(--settings-switch-width)')
    expect(effective('.plugin-switch', 'height')).toBe('var(--settings-switch-height)')

    // A page-scoped override (`.web-settings-row .plugin-switch`) is exactly how the three
    // geometries — 32x18, 36x20 and 48x30 — appeared, so no selector outside the base rule and
    // its own parts may mention the switch. `:not(.plugin-switch)` excludes, it does not override.
    const pageScoped = [...new Set(
      rules
        .flatMap((rule) => rule.selector.split(',').map((part) => part.trim()))
        .filter((selector) => selector.includes('plugin-switch'))
        .filter((selector) => !selector.startsWith('.plugin-switch'))
        .filter((selector) => !selector.includes(':not(')),
    )]

    expect(pageScoped).toEqual([])
  })

  it('declares no settings value twice outside a group-to-member refinement', () => {
    // Four stacked rounds restated the same selector: a page title at 22, 26 and 36px, rows at 56,
    // 64, 68 and 90px, row actions at 30px in one round and 42px in the next, and per-page row
    // geometry that the last round overrode for every page. The key is each selector inside a
    // selector list rather than the whole list, because `.a { … }` followed by `.a, .b { … }` is
    // exactly how the override stayed invisible — the first version of this guard keyed on the
    // full list and therefore saw nothing. A group rule that gives its members a shared base may
    // still be refined by a rule that names one member: that is a stated hierarchy, not drift, so
    // only an earlier declaration from a single-selector rule counts.
    const tracked = new Set([
      'font-size', 'font-weight', 'line-height',
      'min-height', 'width', 'gap', 'margin-top', 'margin-bottom', 'padding',
      'grid-template-columns', 'border-radius',
    ])
    const settingsFamily = /settings|provider|plugin|development-environment|storage|web-|profile-choice|active-run|application-background/u
    const seen = new Map<string, { value: string; fromSingleSelectorRule: boolean }>()
    const conflicts: string[] = []

    for (const rule of rules) {
      const parts = rule.selector.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
      if (!parts.some((part) => settingsFamily.test(part))) continue
      const fromSingleSelectorRule = parts.length === 1
      for (const match of rule.body.matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;]+)/gu)) {
        const property = match[1] ?? ''
        if (!tracked.has(property)) continue
        const value = (match[2] ?? '').trim().replace(/\s+/gu, ' ')
        for (const part of parts) {
          const key = `${part}||${property}`
          const previous = seen.get(key)
          if (previous?.fromSingleSelectorRule && previous.value !== value) {
            conflicts.push(`${part} { ${property}: ${previous.value} -> ${value} }`)
          }
          seen.set(key, { value, fromSingleSelectorRule })
        }
      }
    }

    expect(conflicts).toEqual([])
  })

  it('only targets settings classes that a component actually renders', async () => {
    // The earlier rounds styled `.development-environment-group-heading`, which no component ever
    // rendered — the development-environment page silently kept its 11px label while the CSS
    // looked like it had covered the page. These are the classes the settings surface depends on.
    const used = await readRendererComponents()

    for (const name of [
      'settings-page-transition',
      'settings-module-page',
      'settings-module-heading',
      'settings-module-kicker',
      'settings-overview-group-title',
      'settings-overview-row',
      'storage-settings-heading',
      'storage-settings-row',
      'storage-settings-notice',
      'settings-policy-heading',
      'settings-policy-row',
      'web-settings-heading',
      'web-settings-row',
      'web-provider-note',
      'development-environment-group-title',
      'development-environment-row',
      'development-environment-status',
      'application-background-section-heading',
      'profile-choice-list',
      'plugin-list-disclosure',
      'plugin-list-title',
      'plugin-list-description',
      'plugin-list-meta',
      'plugin-list-error',
      'plugin-runtime-state',
      'plugin-diagnostics',
      'plugin-switch',
      'provider-card-title',
      'provider-badge',
      'provider-model-field-label',
      'provider-model-columns',
      'provider-editor-key-note',
      'active-run-state',
      'active-run-actions',
    ]) {
      expect(used, `${name} should be rendered by a component`).toContain(name)
    }
  })
})

async function readRendererComponents(): Promise<string> {
  const parts: string[] = []
  async function walk(directory: URL): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'assets') continue
      if (entry.isDirectory()) {
        await walk(new URL(`${entry.name}/`, directory))
      } else if (entry.name.endsWith('.tsx')) {
        parts.push(await readFile(new URL(entry.name, directory), 'utf8'))
      }
    }
  }
  await walk(new URL('.', import.meta.url))
  return parts.join('\n')
}
