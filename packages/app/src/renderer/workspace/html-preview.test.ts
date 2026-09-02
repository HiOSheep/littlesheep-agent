import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('workspace HTML preview', () => {
  it('uses a sanitized srcdoc inside a scriptless sandbox', async () => {
    const source = await readSource('./html-preview.tsx')

    expect(source).toContain("import DOMPurify from 'dompurify'")
    expect(source).toContain('DOMPurify.sanitize(source, {')
    expect(source).toContain("'script'")
    expect(source).toContain("'iframe'")
    expect(source).toContain("FORBID_ATTR: HTML_PREVIEW_FORBID_ATTR")
    expect(source).toContain('sandbox=""')
    expect(source).toContain('srcDoc={srcDoc}')
    expect(source).toContain('connect-src \'none\'')
  })

  it('injects a controlled base URL so local styles and assets resolve from the HTML file', async () => {
    const source = await readSource('./html-preview.tsx')

    expect(source).toContain('new URL(\'.\', attachmentFileUrl(filePath)).href')
    expect(source).toContain('<base href=')
    expect(source).toContain('escapeHtmlAttribute(resolveHtmlBaseUrl(filePath))')
  })
})

function readSource(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
