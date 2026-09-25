// UX-25 item 2: relative CSS / image / font paths and CSS `url()`, including the
// awkward names the item lists (subdirectories, Chinese, spaces, `#`, `%`) and
// references that do not exist. Main validates the path; nothing here weakens the
// sandbox, and the frame still cannot fetch anything of its own.
import { describe, expect, it } from 'vitest'
import {
  encodeRelativePath,
  htmlPreviewNeedsAssets,
  resolvePreviewAssetUrl,
  rewritePreviewAssets,
} from './html-preview-assets'

const context = {
  base: 'http://127.0.0.1:41234/ab12/',
  documentPath: 'multi-file/index.html',
}

describe('preview asset resolution', () => {
  it('resolves relative references against the document directory', () => {
    expect(resolvePreviewAssetUrl('game.css', context)).toBe('http://127.0.0.1:41234/ab12/multi-file/game.css')
    expect(resolvePreviewAssetUrl('./sprite.svg', context)).toBe('http://127.0.0.1:41234/ab12/multi-file/sprite.svg')
    expect(resolvePreviewAssetUrl('../shared/tile.svg', context)).toBe('http://127.0.0.1:41234/ab12/shared/tile.svg')
    // Root-relative references resolve from the workspace root, like a server would.
    expect(resolvePreviewAssetUrl('/assets/tile.svg', context)).toBe('http://127.0.0.1:41234/ab12/assets/tile.svg')
  })

  it('encodes the names the item calls out and keeps query and fragment', () => {
    expect(encodeRelativePath('素材/背景 图.png', 'index.html')).toBe('%E7%B4%A0%E6%9D%90/%E8%83%8C%E6%99%AF%20%E5%9B%BE.png')
    // `#` and `%` inside a *file name* must survive as data, not as URL syntax.
    expect(encodeRelativePath('shots/shot#1.png', 'index.html')).toBe('shots/shot%231.png')
    expect(encodeRelativePath('shots/100%.png', 'index.html')).toBe('shots/100%25.png')
    // Encoding is idempotent: a page that already encoded its reference stays correct
    // instead of becoming `%2523` / `%2525`.
    expect(encodeRelativePath('shots/shot%231.png', 'index.html')).toBe('shots/shot%231.png')
    expect(encodeRelativePath('shots/100%25.png', 'index.html')).toBe('shots/100%25.png')
    expect(resolvePreviewAssetUrl('shots/shot%231.png', context)).toBe('http://127.0.0.1:41234/ab12/multi-file/shots/shot%231.png')
    expect(resolvePreviewAssetUrl('img/a.png?v=2#top', context)).toBe('http://127.0.0.1:41234/ab12/multi-file/img/a.png?v=2#top')
  })

  it('leaves absolute references alone and refuses one that escapes the root', () => {
    for (const value of ['data:image/png;base64,AAAA', 'blob:http://x/y', 'https://example.com/a.png', '//cdn/a.png', '#anchor', '']) {
      expect(resolvePreviewAssetUrl(value, context)).toBe(value)
    }
    expect(resolvePreviewAssetUrl('../../../etc/passwd', context)).toBeNull()
    expect(resolvePreviewAssetUrl('../../outside.png', context)).toBeNull()
  })

  it('rewrites tags, srcset, inline styles and style blocks', () => {
    const html = [
      '<link rel="stylesheet" href="game.css">',
      '<img class="sprite" src="sprite.svg" width="48">',
      '<img src="a.png 1x, b.png 2x" srcset="a.png 1x, b.png 2x">',
      '<video poster="../media/poster 图.png" src="clip.mp4"></video>',
      '<div style="background: url(\'素材/背景 图.png\')"></div>',
      '<style>@font-face { src: url("fonts/x.woff2") } .a { background: url(shots/shot#1.png) }</style>',
      '<a href="other.html">另一个页面</a>',
    ].join('\n')

    const result = rewritePreviewAssets(html, context)

    expect(result.html).toContain('href="http://127.0.0.1:41234/ab12/multi-file/game.css"')
    expect(result.html).toContain('src="http://127.0.0.1:41234/ab12/multi-file/sprite.svg"')
    expect(result.html).toContain('srcset="http://127.0.0.1:41234/ab12/multi-file/a.png 1x, http://127.0.0.1:41234/ab12/multi-file/b.png 2x"')
    expect(result.html).toContain('poster="http://127.0.0.1:41234/ab12/media/poster%20%E5%9B%BE.png"')
    // Inside a `style` attribute the rewritten url keeps valid HTML quoting.
    expect(result.html).toContain('url(&quot;http://127.0.0.1:41234/ab12/multi-file/%E7%B4%A0%E6%9D%90/%E8%83%8C%E6%99%AF%20%E5%9B%BE.png&quot;)')
    expect(result.html).toContain('src: url("http://127.0.0.1:41234/ab12/multi-file/fonts/x.woff2")')
    expect(result.html).toContain('url("http://127.0.0.1:41234/ab12/multi-file/shots/shot#1.png")')
    // Navigation is not this function's business.
    expect(result.html).toContain('<a href="other.html">')
    expect(result.refused).toEqual([])
    expect(result.rewritten.length).toBeGreaterThan(6)
  })

  it('keeps a stylesheet link and drops every other link the document may carry', () => {
    const html = [
      '<link rel="stylesheet" href="game.css">',
      "<link rel='stylesheet' href='theme.css'>",
      '<link rel="preload" href="big.woff2" as="font">',
      '<link rel="icon" href="favicon.ico">',
      '<link rel="manifest" href="app.webmanifest">',
      '<link rel="prefetch" href="https://example.com/x">',
    ].join('\n')

    const result = rewritePreviewAssets(html, context)

    expect(result.html).toContain('href="http://127.0.0.1:41234/ab12/multi-file/game.css"')
    expect(result.html).toContain('href="http://127.0.0.1:41234/ab12/multi-file/theme.css"')
    // Reaching for the network is what the preview promises not to do.
    expect(result.html).not.toContain('preload')
    expect(result.html).not.toContain('favicon.ico')
    expect(result.html).not.toContain('app.webmanifest')
    expect(result.html).not.toContain('example.com')
  })
  it('rewrites a reference that does not exist instead of dropping it', () => {
    // The request must happen: Main records the failure and the toolbar can name it.
    const result = rewritePreviewAssets('<img src="missing-image.png">', context)
    expect(result.html).toContain('src="http://127.0.0.1:41234/ab12/multi-file/missing-image.png"')
  })

  it('leaves an unquoted CSS url with a space alone, because that CSS is invalid', () => {
    // `url(a b.png)` is not a valid CSS url-token, so a browser drops the declaration
    // and there is nothing to resolve; names with spaces work through quoted CSS urls
    // and through HTML attributes, both covered above.
    const result = rewritePreviewAssets('<style>.a{background:url(素材/背景 图.png)}</style>', context)
    expect(result.html).toContain('url(素材/背景 图.png)')
    expect(result.rewritten).toEqual([])
  })

  it('reports refused references so the caller can say why', () => {
    const result = rewritePreviewAssets('<img src="../../secret.png">', context)
    expect(result.refused).toEqual(['../../secret.png'])
    expect(result.html).toContain('src="../../secret.png"')
  })

  it('knows whether a document needs the asset service at all', () => {
    expect(htmlPreviewNeedsAssets('<img src="a.png">')).toBe(true)
    expect(htmlPreviewNeedsAssets('<style>.a{background:url(b.png)}</style>')).toBe(true)
    expect(htmlPreviewNeedsAssets('<style>@import "theme.css";</style>')).toBe(true)
    expect(htmlPreviewNeedsAssets('<img src="data:image/png;base64,AA">')).toBe(false)
    expect(htmlPreviewNeedsAssets('<img src="https://example.com/a.png">')).toBe(false)
    expect(htmlPreviewNeedsAssets('<p>纯文字</p>')).toBe(false)
  })
})
