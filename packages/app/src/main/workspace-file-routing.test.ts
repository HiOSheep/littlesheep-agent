// @littlesheep/app - workspace-file-routing.test.ts

import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_IMAGE_EXTS,
  WORKSPACE_HTML_EXTS,
  WORKSPACE_MARKDOWN_EXTS,
  WORKSPACE_OFFICE_EXTS,
  WORKSPACE_PDF_EXTS,
  classifyWorkspaceFileSurface,
  isWorkspaceTextLikeFile,
  previewLanguageForWorkspaceFile,
} from './workspace-file-routing.js'

describe('workspace file routing', () => {
  it('routes code, scripts, config, Markdown, and lock files into the built-in editor', () => {
    expect(isWorkspaceTextLikeFile('index.tsx', '.tsx')).toBe(true)
    expect(classifyWorkspaceFileSurface('index.tsx', '.tsx')).toBe('builtinEditor')
    expect(previewLanguageForWorkspaceFile('index.tsx', '.tsx')).toBe('typescript')

    expect(isWorkspaceTextLikeFile('script.ps1', '.ps1')).toBe(true)
    expect(classifyWorkspaceFileSurface('script.ps1', '.ps1')).toBe('builtinEditor')
    expect(previewLanguageForWorkspaceFile('script.ps1', '.ps1')).toBe('powershell')

    expect(isWorkspaceTextLikeFile('dockerfile', '')).toBe(true)
    expect(classifyWorkspaceFileSurface('dockerfile', '')).toBe('builtinEditor')
    expect(previewLanguageForWorkspaceFile('dockerfile', '')).toBe('dockerfile')

    expect(WORKSPACE_MARKDOWN_EXTS.has('.mdx')).toBe(true)
    expect(classifyWorkspaceFileSurface('notes.mdx', '.mdx')).toBe('builtinEditor')
    expect(classifyWorkspaceFileSurface('pnpm-lock.yaml', '.yaml')).toBe('builtinEditor')
  })

  it('keeps images, PDFs, and Office files out of the built-in editor', () => {
    expect(WORKSPACE_IMAGE_EXTS.has('.png')).toBe(true)
    expect(WORKSPACE_IMAGE_EXTS.has('.svg')).toBe(true)
    expect(WORKSPACE_PDF_EXTS.has('.pdf')).toBe(true)
    expect(WORKSPACE_OFFICE_EXTS.has('.docx')).toBe(true)
    expect(WORKSPACE_OFFICE_EXTS.has('.pptx')).toBe(true)
    expect(WORKSPACE_OFFICE_EXTS.has('.pptm')).toBe(true)
    expect(WORKSPACE_OFFICE_EXTS.has('.xlsx')).toBe(true)

    expect(classifyWorkspaceFileSurface('photo.png', '.png')).toBe('imagePreview')
    expect(classifyWorkspaceFileSurface('diagram.svg', '.svg')).toBe('imagePreview')
    expect(classifyWorkspaceFileSurface('brief.pdf', '.pdf')).toBe('pdfPreview')
    expect(classifyWorkspaceFileSurface('slides.pptx', '.pptx')).toBe('documentCard')
    expect(classifyWorkspaceFileSurface('notes.docx', '.docx')).toBe('documentCard')

    expect(isWorkspaceTextLikeFile('slides.pptx', '.pptx')).toBe(false)
    expect(isWorkspaceTextLikeFile('photo.png', '.png')).toBe(false)
  })

  it('routes HTML documents to the rendered HTML preview surface', () => {
    expect(WORKSPACE_HTML_EXTS.has('.html')).toBe(true)
    expect(WORKSPACE_HTML_EXTS.has('.htm')).toBe(true)
    expect(WORKSPACE_HTML_EXTS.has('.xhtml')).toBe(true)
    expect(classifyWorkspaceFileSurface('snake-game.html', '.html')).toBe('htmlPreview')
    expect(classifyWorkspaceFileSurface('legacy.htm', '.htm')).toBe('htmlPreview')
    expect(classifyWorkspaceFileSurface('document.xhtml', '.xhtml')).toBe('htmlPreview')
  })

  it('sniffs unknown extensions before falling back to an unsupported file card', () => {
    expect(classifyWorkspaceFileSurface('custom.unknown', '.unknown')).toBe('sniffText')
  })
})
