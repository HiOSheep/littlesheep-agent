// O2 (long-content reading): the three contracts this item changed, asserted where a node test
// can see them. The real-window numbers that motivated each one are recorded in the taskbook
// and in `chat/README.md`; these tests keep the rules from silently drifting back.
//
//   1. a wide GFM table scrolls inside its own wrapper instead of being squeezed into the
//      column (the chat-scoped rule must outrank the shared preview rule);
//   2. the lazy highlighter's plain fallback occupies the same box as the highlighted state,
//      so the swap cannot move the blocks below the code;
//   3. the scroll controller corrects a height change that happens *inside* the turn the
//      reader is in, without turning into a bottom pull and without fighting the reader's own
//      disclosure clicks.
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { readRendererStyleSource } from '../style-source-test-utils'

async function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

/** Declarations of one rule body, keyed by property, later declarations winning. */
function declarations(styles: string, selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  // Anchored at the start of a line so a selector that merely ends a shared group
  // (`.markdown p, …, .markdown-table-wrap { … }`) is not mistaken for its own rule, and every
  // matching rule is merged in source order — the same way the cascade reads them.
  const matches = styles.matchAll(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'gmu'))
  const map = new Map<string, string>()
  let found = false
  for (const match of matches) {
    found = true
    for (const declaration of (match[1] ?? '').split(';')) {
      const [property, ...rest] = declaration.split(':')
      if (!property || rest.length === 0) continue
      map.set(property.trim(), rest.join(':').trim())
    }
  }
  if (!found) throw new Error(`rule not found: ${selector}`)
  return map
}

/** Class+attribute and element counts of one compound selector, for "which rule wins". */
function specificity(selector: string): [number, number] {
  const classes = selector.match(/\.[\w-]+|\[[^\]]+\]/gu)?.length ?? 0
  const elements = selector.match(/(?:^|\s|>)[a-z]+/gu)?.length ?? 0
  return [classes, elements]
}

describe('long-content reading layout (chat)', () => {
  it('scrolls a wide table inside its own wrapper instead of squeezing it into the column', async () => {
    const styles = await readRendererStyleSource()

    // The wrapper is the scroll region and stays inside the column.
    const wrap = declarations(styles, '.markdown-table-wrap')
    expect(wrap.get('width')).toBe('100%')
    expect(wrap.get('max-width')).toBe('100%')
    expect(wrap.get('overflow-x')).toBe('auto')

    // The shared rule (which the workspace Markdown preview is asserted against) is untouched...
    const base = declarations(styles, '.markdown-table-wrap table')
    expect(base.get('width')).toBe('100%')
    expect(base.get('min-width')).toBe('100%')
    expect(base.get('border-collapse')).toBe('separate')

    // ...and the chat-scoped rule is what gives the columns the width their content needs.
    const chat = declarations(styles, '.message .markdown-table-wrap table')
    expect(chat.get('min-width')).toBe('max-content')
    expect(specificity('.message .markdown-table-wrap table')[0])
      .toBeGreaterThan(specificity('.markdown-table-wrap table')[0])
    expect(styles.indexOf('.message .markdown-table-wrap table'))
      .toBeGreaterThan(styles.indexOf('.markdown-table-wrap table'))
  })

  it('renders the highlighter fallback in the box the highlighter itself uses', async () => {
    const markdown = await source('../Markdown.tsx')

    // Both states go through one style source: the fallback is not a second set of numbers.
    expect(markdown.match(/codeSourceStyle\(wrapped\)/gu)?.length).toBe(2)
    expect(markdown).toContain("oneDark['code[class*=\"language-\"]']")
    expect(markdown).toMatch(/padding:\s*'var\(--code-block-inset\)'/)
    expect(markdown).toMatch(/margin:\s*0,/)

    // The fallback is an element, not a `<pre>`: the highlighted state is the highlighter's
    // `PreTag` div, and only the same tag keeps `pre`-scoped rules out of its box.
    const fallback = markdown.slice(
      markdown.indexOf('function PlainCodeFallback'),
      markdown.indexOf('function CodeBlock'),
    )
    // Comments are dropped first: this one explains the tag choice by naming the old one.
    const fallbackJsx = fallback.replace(/\{\/\*[\s\S]*?\*\/\}/gu, '')
    expect(fallbackJsx).toContain("className=\"code-block-source\"")
    expect(fallbackJsx).toContain("data-code-wrap={wrapped ? 'on' : 'off'}")
    expect(fallbackJsx).toContain('style={source.source}')
    expect(fallbackJsx).toContain('style={source.code}')
    expect(fallbackJsx).not.toContain('<pre')

    // ...and the highlighted state reads the same two objects, so neither can drift alone.
    const highlighter = markdown.slice(markdown.indexOf('<SyntaxHighlighter'))
    expect(highlighter).toContain('style: source.code')
    expect(highlighter).toContain('customStyle={source.source}')
  })

  it('keeps the table rule scoped to the chat reply and the code box shared', async () => {
    // The controller half of this item was measured and reverted (the animated settle fold is
    // still open — see `chat/README.md`); what is asserted here is what shipped.
    const styles = await readRendererStyleSource()
    expect(declarations(styles, '.message .markdown-table-wrap table').get('min-width')).toBe('max-content')
    const markdown = await source('../Markdown.tsx')
    expect(markdown.match(/codeSourceStyle\(wrapped\)/gu)?.length).toBe(2)
  })
})
