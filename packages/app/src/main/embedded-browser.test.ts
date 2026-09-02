import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('embedded browser plain-text contrast', () => {
  it('injects a scoped high-contrast stylesheet for text documents only', async () => {
    const source = await readFile(new URL('./embedded-browser.ts', import.meta.url), 'utf8')

    expect(source).toContain("let isPlainText = isRawTextDocumentUrl(pageUrl)")
    expect(source).toContain("document.contentType")
    expect(source).toContain("raw|gist)\\.githubusercontent\\.com")
    expect(source).toContain('color: #202020 !important')
    expect(source).toContain('background: #ffffff !important')
    expect(source).toContain('background: #4f6fdc !important')
    expect(source).toContain("guestContents.on('did-finish-load'")
    expect(source).toContain('guestContents.insertCSS')
    expect(source).toContain('Some sandboxed guests reject executeJavaScript')
  })
})
