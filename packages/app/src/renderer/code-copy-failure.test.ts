// O4 (honest failure) for the code block. `CopyButton` used to be `await
// navigator.clipboard.writeText(text)` with nothing around it: a refused write rejected that
// promise, the `void copy()` dropped the rejection, and the block kept showing its idle mark — the
// reader neither learned the copy failed nor got a second chance. `chat/message-meta.tsx` fixed the
// same defect on the message action row; these checks hold the code block to that pattern.
//
// The rejection itself needs a real window (a `Browser.setPermission` refusal). What a node test can
// pin is the shape that makes it work: the write decides the state, the refusal is a state of its
// own, the note with its retry is part of the control, and the stylesheet keeps that note readable
// after the pointer leaves the one code surface that fades with it.
import { readFile } from 'node:fs/promises'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readRendererStyleSource } from './style-source-test-utils'
import { Markdown } from './Markdown'

beforeAll(() => vi.stubGlobal('React', React))
afterAll(() => vi.unstubAllGlobals())

const CODE_BLOCK = '```js\nconst value = 1\n```'

interface StyleRule {
  selector: string
  body: string
  order: number
}

async function markdownSource(): Promise<string> {
  return readFile(new URL('./Markdown.tsx', import.meta.url), 'utf8')
}

/** The `{...}` body that follows `head` in `source`, with its braces balanced. */
function bracedBody(source: string, head: string): string {
  const start = source.indexOf(head)
  if (start < 0) throw new Error(`not found: ${head}`)
  let depth = 0
  for (let index = start + head.length - 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start + head.length, index)
    }
  }
  throw new Error(`unterminated body: ${head}`)
}

function functionBody(source: string, name: string): string {
  return bracedBody(source, `async function ${name}() {`)
}

/** [classes + attributes + pseudo-classes, elements] of one compound selector. */
function specificity(selector: string): readonly [number, number] {
  return [
    selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/gu)?.length ?? 0,
    selector.match(/(?:^|[\s>+~])[a-z]+/gu)?.length ?? 0,
  ] as const
}

function rules(styles: string): StyleRule[] {
  return [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map(([, selector, body], order) => ({
    selector: (selector ?? '').trim().replace(/\s+/gu, ' '),
    body: body ?? '',
    order,
  }))
}

/**
 * Whether `candidate` really hands its declarations to the retry button.
 *
 * `.code-toolbar button` already gives every button in the toolbar a 26px circular box, and it is a
 * class *plus* an element. A bare `.code-copy-retry` rule therefore loses width, height, min-height,
 * padding, border and radius to it wherever it sits in the file, however good it reads —
 * `reading-continuity.test.ts` reasons about the shared table rule the same way.
 */
function outranksToolbarButton(styles: string, candidate: StyleRule): boolean {
  const base = rules(styles).find((rule) => rule.selector === '.code-toolbar button')
  if (!base) throw new Error('rule not found: .code-toolbar button')
  const [baseClasses, baseElements] = specificity('.code-toolbar button')
  return candidate.selector
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /\.code-copy-retry\b/u.test(part))
    .some((part) => {
      const [classes, elements] = specificity(part)
      if (classes !== baseClasses) return classes > baseClasses
      if (elements !== baseElements) return elements > baseElements
      return candidate.order > base.order
    })
}

/** The block's real markup: the highlighter chunk is lazy, so this is the plain-text fallback box. */
function renderCodeBlock(): string {
  return renderToStaticMarkup(createElement(Markdown, { text: CODE_BLOCK }))
}

describe('code block copy control', () => {
  it('claims a copy only after the clipboard write resolves', async () => {
    // The write is the only evidence the text reached the clipboard, so the success state must come
    // after it resolves and never on the click: a state set before the `await` would report a copy
    // that a refused write never performed.
    const copy = functionBody(await markdownSource(), 'copy')
    const write = copy.indexOf('await navigator.clipboard.writeText(text)')
    const success = copy.indexOf("setCopyState('copied')")

    expect(write).toBeGreaterThanOrEqual(0)
    expect(success).toBeGreaterThan(write)
    expect(copy.match(/setCopyState\('copied'\)/gu)).toHaveLength(1)
  })

  it('reports a refused write in the handler that caught it, instead of returning silently', async () => {
    const copy = functionBody(await markdownSource(), 'copy')
    const failure = bracedBody(copy, 'catch {')

    expect(failure).toContain("setCopyState('failed')")
    // The shape this replaces: a refusal that ends the handler without saying anything.
    expect(failure.replace(/\s/gu, '')).not.toBe('return')
  })

  it('carries the failure note and its retry on the control, and none of it while idle', async () => {
    const [source, idle] = await Promise.all([markdownSource(), Promise.resolve(renderCodeBlock())])

    expect(idle).toContain('data-copy-state="idle"')
    expect(idle).toContain('aria-label="复制代码"')
    expect(idle).toContain('data-copied="false"')
    expect(idle).not.toContain('code-copy-failed-row')

    expect(source).toMatch(/\{copyState === 'failed' && \(/)
    expect(source).toContain('<span className="code-copy-failed" role="status">复制失败</span>')
    expect(source).toContain('className="code-copy-retry"')
    expect(source).toContain('重试</button>')
  })

  it('keeps the failure readable after the pointer leaves the code row that fades', async () => {
    // Only the mermaid overlay fades with the pointer (`.mermaid-block > .code-toolbar { opacity: 0 }`,
    // asserted where the overlay is owned). The note travels with the control inside that overlay, so
    // the failure state has to hold the overlay open — a note that left with the pointer would not be
    // feedback. The plain code block's toolbar never fades, so its note is readable as it stands.
    const styles = await readRendererStyleSource()
    const source = await markdownSource()

    // The stylesheet keys on the classes the control renders, so a rename on one side alone would
    // leave the note unstyled and the fading toolbar unheld — the two halves are checked together.
    for (const className of ['code-copy-failed-row', 'code-copy-failed', 'code-copy-retry']) {
      expect(source).toContain(`className="${className}"`)
    }

    expect(styles).toMatch(/\.code-toolbar button\[data-copy-state="failed"\]\s*\{[^}]*color:\s*var\(--feedback-danger-text\);/u)
    expect(styles).toMatch(/\.code-copy-failed-row\s*\{[^}]*display:\s*(?:inline-)?flex;[^}]*align-items:\s*center;[^}]*gap:\s*6px;/u)
    expect(styles).toMatch(/\.code-copy-failed\s*\{[^}]*color:\s*var\(--feedback-danger-text\);/u)
    expect(styles).toMatch(/\.mermaid-block:has\(\.code-copy-failed-row\)\s*>\s*\.code-toolbar\s*\{[^}]*opacity:\s*1;/u)

    // The retry keeps the message row's metrics instead of the toolbar's 26px circular copy box, which
    // only a selector that outranks `.code-toolbar button` can do.
    const retryBox = rules(styles)
      .filter((rule) => /\.code-copy-retry\b/u.test(rule.selector))
      .filter((rule) => /border-radius:\s*var\(--radius-ui\)/u.test(rule.body))
      .at(-1)
    expect(retryBox).toBeDefined()
    expect(outranksToolbarButton(styles, retryBox!)).toBe(true)
    expect(retryBox!.body).toMatch(/(?:^|;)\s*width:\s*auto;/u)
    expect(retryBox!.body).toMatch(/(?:^|;)\s*min-height:\s*20px;/u)
    expect(styles).toMatch(/\.code-copy-retry:hover,[\s\S]*?\.code-copy-retry:focus-visible\s*\{[^}]*background:\s*var\(--control-hover\);/u)
  })

  it('leaves the language label, the wrap toggle and the shared code box in place', () => {
    const idle = renderCodeBlock()

    expect(idle).toContain('<span class="code-language-label">JS</span>')
    expect(idle).toContain('aria-pressed="false"')
    expect(idle).toContain('class="code-block-source"')
    expect(idle).toContain('data-code-wrap="off"')
  })
})
