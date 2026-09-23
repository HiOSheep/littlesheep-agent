import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { InlineMarkdown } from './inline-markdown'

// Vitest runs these files in a node environment without the automatic JSX
// runtime global, which the component modules rely on; the existing renderer
// tests stub it the same way.
beforeAll(() => vi.stubGlobal('React', React))
afterAll(() => vi.unstubAllGlobals())

function render(text: string): string {
  return renderToStaticMarkup(createElement(InlineMarkdown, { text }))
}

describe('inline markdown for activity labels', () => {
  it('renders the emphasis and code spans these labels actually use', () => {
    expect(render('**scan**files')).toBe('<span class="markdown markdown-inline"><strong>scan</strong>files</span>')
    expect(render('read `package.json`')).toContain('<code class="markdown-inline-code">package.json</code>')
    expect(render('*emphasis*text')).toContain('<em>emphasis</em>')
    expect(render('~~removed~~text')).toContain('<del>removed</del>')
  })

  it('leaves anything it does not model as literal text', () => {
    // Links, HTML and malformed delimiters stay literal: an activity label is a
    // label, and keeping the scanner bounded is what keeps it out of the entry
    // path dependency graph.
    expect(render('[link](https://example.com)')).toContain('[link](https://example.com)')
    expect(render('<b>bold</b>')).toContain('&lt;b&gt;bold&lt;/b&gt;')
    expect(render('unclosed **emphasis')).toContain('unclosed **emphasis')
    expect(render('plain step')).toBe('<span class="markdown markdown-inline">plain step</span>')
  })

  it('keeps the emphasis precedence deterministic', () => {
    expect(render('**a**and*b*')).toBe('<span class="markdown markdown-inline"><strong>a</strong>and<em>b</em></span>')
    expect(render('`**not bold**`')).toContain('<code class="markdown-inline-code">**not bold**</code>')
  })
})
