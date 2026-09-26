import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CopyIcon, FileGlyphIcon, FolderGlyphIcon, PinIcon, SendRunIcon, SidebarToggleIcon, StopRunIcon, fileGlyphKind } from './icons'

vi.stubGlobal('React', React)

describe('PinIcon', () => {
  it('keeps the default pin outlined and uses a solid active state', () => {
    const inactive = renderToStaticMarkup(React.createElement(PinIcon, { active: false }))
    const active = renderToStaticMarkup(React.createElement(PinIcon, { active: true }))

    expect(inactive).not.toContain('pin-icon-solid')
    expect(inactive).not.toContain('pin-icon active')
    expect(active).toContain('pin-icon active')
    expect(active).toContain('pin-icon-solid')
  })
})

describe('composer run icons', () => {
  it('keeps the send-arrow optical alignment separate from the centered stop icon', () => {
    const send = renderToStaticMarkup(React.createElement(SendRunIcon))
    const stop = renderToStaticMarkup(React.createElement(StopRunIcon))

    expect(send).toContain('class="send-round-icon send"')
    expect(send).toContain('shape-rendering="geometricPrecision"')
    expect(send).toContain('d="M8.5 13V3M5 6.5 8.5 3 12 6.5"')
    expect(stop).toContain('class="send-round-icon stop"')
  })
})

describe('SidebarToggleIcon', () => {
  it('uses a pixel-aligned 3px SVG outline without scale-dependent CSS borders', () => {
    const icon = renderToStaticMarkup(React.createElement(SidebarToggleIcon))

    expect(icon).toContain('viewBox="0 0 18 14"')
    expect(icon).toContain('shape-rendering="geometricPrecision"')
    expect(icon).toContain('x="0.5" y="0.5" width="17" height="13" rx="3"')
    expect(icon).toContain('d="M9.5 3v8"')
  })
})

describe('CopyIcon', () => {
  it('renders a compact overlapping-document copy glyph', () => {
    const icon = renderToStaticMarkup(React.createElement(CopyIcon))

    expect(icon).toContain('class="sidebar-svg-icon copy-icon"')
    expect(icon).toContain('shape-rendering="geometricPrecision"')
    expect(icon).toContain('x="3.25" y="5.25" width="7.5" height="7.5"')
    expect(icon).toContain('x="5.25" y="2.75" width="7.5" height="8.5"')
  })
})

describe('FileGlyphIcon', () => {
  it('classifies common file types and renders their type-specific marks', () => {
    expect(fileGlyphKind('README.md')).toBe('markdown')
    expect(fileGlyphKind('src/main.py')).toBe('python')
    expect(fileGlyphKind('package.json')).toBe('json')
    expect(fileGlyphKind('app.tsx')).toBe('typescript')
    expect(fileGlyphKind('unknown.custom')).toBe('generic')

    const markdown = renderToStaticMarkup(FileGlyphIcon({ name: 'README.md' }))
    const html = renderToStaticMarkup(FileGlyphIcon({ name: 'index.html' }))
    const generic = renderToStaticMarkup(FileGlyphIcon({ name: 'unknown.custom' }))

    expect(markdown).toContain('file-glyph-markdown')
    // The mark is the type's own, not a first letter: Markdown "MD", HTML5 "5".
    expect(markdown).toContain('>MD</text>')
    expect(html).toContain('>5</text>')
    // YAML's mark is two characters so it fits the plate at the size the tree renders it.
    const yaml = renderToStaticMarkup(FileGlyphIcon({ name: 'pnpm-workspace.yaml' }))
    expect(yaml).toContain('>YL</text>')
    // Rounded plate: every sheet is the shared rounded path with a folded corner.
    expect(markdown).toContain('file-glyph-sheet')
    expect(markdown).toContain('file-glyph-fold')
    expect(generic).toContain('file-glyph-generic')
    expect(generic).not.toContain('file-glyph-label')

    const folder = renderToStaticMarkup(FolderGlyphIcon())
    expect(folder).toContain('folder-glyph-icon')
    expect(folder).toContain('folder-glyph-body')
    expect(folder).toContain('folder-glyph-bar')
  })
})
