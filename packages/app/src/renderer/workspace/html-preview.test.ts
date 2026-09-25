import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('workspace HTML preview', () => {
  it('uses a sanitized srcdoc inside a scriptless sandbox', async () => {
    const source = await readSource('./html-preview.tsx')

    expect(source).toContain("import DOMPurify from 'dompurify'")
    expect(source).toContain('DOMPurify.sanitize(source, {')
    expect(source).toContain("'script'")
    expect(source).toContain("'iframe'")
    expect(source).toContain('FORBID_ATTR: HTML_PREVIEW_FORBID_ATTR')
    expect(source).toContain('sandbox=""')
    expect(source).toContain('srcDoc={srcDoc}')
    expect(source).toContain('connect-src \'none\'')
    // Script-capable and navigation-capable head elements stay forbidden.
    expect(source).toContain("'meta'")
  })

  it('sanitizes the whole document so a page keeps its head, title and styles', async () => {
    const source = await readSource('./html-preview.tsx')

    // UX-25: run as a fragment the sanitizer dropped <head>, and every <style> rule
    // with it, so a styled page rendered as unstyled text on white (measured).
    expect(source).toContain('WHOLE_DOCUMENT: true')
    expect(source).toContain("const HTML_PREVIEW_ADD_TAGS = ['title']")
    expect(source).toContain('ADD_TAGS: HTML_PREVIEW_ADD_TAGS')
  })

  it('creates the frame only for a real document and keys it by that document', async () => {
    const source = await readSource('./html-preview.tsx')

    // UX-25: a srcdoc set while the frame still loaded its empty document could be
    // ignored, which left the preview blank; a frame is now created per document.
    expect(source).toContain('if (!content.trim())')
    expect(source).toContain('key={previewDocumentKey(path, srcDoc)}')
    expect(source).toContain('export function previewDocumentKey')
    expect(source).toContain('静态预览：保留标题与样式，不运行页面脚本，也不发起网络请求。')
  })

  it('injects a controlled base URL and charset so local paths resolve from the HTML file', async () => {
    const source = await readSource('./html-preview.tsx')

    expect(source).toContain('new URL(\'.\', attachmentFileUrl(filePath)).href')
    expect(source).toContain('<base href=')
    expect(source).toContain('escapeHtmlAttribute(resolveHtmlBaseUrl(filePath))')
    expect(source).toContain('<meta charset="utf-8">')
  })
})

function readSource(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
