import { readFile } from 'node:fs/promises'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readRendererStyleSource } from '../style-source-test-utils'
import { MessageMeta, formatMessageTime } from './message-meta'

beforeAll(() => vi.stubGlobal('React', React))
afterAll(() => vi.unstubAllGlobals())

describe('message metadata footer', () => {
  it('formats a message timestamp as local hour and minute', () => {
    const timestamp = '2026-08-25T09:07:00.000Z'
    const date = new Date(timestamp)
    const expected = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    expect(formatMessageTime(timestamp)).toBe(expected)
    expect(formatMessageTime('not-a-date')).toBe('')
  })

  it('keeps the footer outside the message box and reveals it only on row hover/focus', async () => {
    const [styles, source] = await Promise.all([
      readRendererStyleSource(),
      readFile(new URL('./message-meta.tsx', import.meta.url), 'utf8'),
    ])
    const html = renderToStaticMarkup(createElement(MessageMeta, {
      role: 'user',
      text: '需要复制的消息',
      timestamp: '2026-08-25T09:07:00.000Z',
    }))

    expect(html).toContain('class="message-meta message-meta-user"')
    expect(html).toContain('aria-label="复制消息"')
    expect(html).toContain('data-copied="false"')
    expect(styles).toMatch(/\.message-meta\s*\{[^}]*height:\s*28px;[^}]*font-size:\s*14px;[^}]*opacity:\s*0;[^}]*pointer-events:\s*auto;/u)
    expect(styles).toMatch(/\.message-meta:hover,[\s\S]*?\.message-meta:focus-within\s*\{[^}]*opacity:\s*1;/u)
    expect(styles).toMatch(/\.message-with-meta\.user\s*\{[^}]*width:\s*min\(820px,\s*100%\);[^}]*max-width:\s*min\(820px,\s*100%\);[^}]*margin-left:\s*auto;/u)
    expect(styles).toMatch(/\.message-with-meta > \.message\s*\{[^}]*margin-bottom:\s*0;/u)
    expect(styles).toMatch(/\.message-with-meta\.user > \.message\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*min\(820px,\s*78%\);[^}]*margin-left:\s*auto;/u)
    expect(styles).toMatch(/\.message-meta-copy\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*min-height:\s*24px;[^}]*border:\s*0;[^}]*border-radius:\s*var\(--radius-circle\);/u)
    expect(styles).toMatch(/\.message-meta-copy\s*\{[^}]*font-size:\s*14px;/u)
    expect(styles).toMatch(/\.message-meta-copy \.sidebar-svg-icon\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;/u)
    const messageMetaCopyHover = styles.slice(
      styles.indexOf('.message-meta-copy:hover'),
      styles.indexOf('.message-file-strip'),
    )
    expect(messageMetaCopyHover).not.toContain('border-color:')
    expect(source).toContain('<CopyIcon />')
    expect(source).toContain('<CheckIcon />')
  })

  it('leaves no control on the row permanently visible', async () => {
    // The row carried a `:has(.message-meta-usage)` exception that pinned every answer's action row
    // open so the token figures could be read at a glance. Checking "an opacity rule exists" is not
    // enough to catch that coming back, so this walks *every* rule that sets the row's own opacity
    // and requires the only two states to be the hidden base and the shared hover/focus reveal.
    // Comments are stripped first: the stylesheet documents the row by name in prose.
    const styles = (await readRendererStyleSource()).replace(/\/\*[\s\S]*?\*\//gu, '')
    const rowOpacity = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .map(([, selector, body]) => ({
        selector: (selector ?? '').trim().replace(/\s+/gu, ' '),
        opacity: /(?:^|;)\s*opacity\s*:\s*([^;]+)/u.exec(body ?? '')?.[1]?.trim(),
      }))
      .filter(({ selector }) => /(?:^|,\s*)\.message-meta(?:[:,]|$)/u.test(selector))
      .filter(({ opacity }) => opacity !== undefined)

    expect(rowOpacity.map(({ selector, opacity }) => `${selector} { opacity: ${opacity} }`)).toEqual([
      '.message-meta { opacity: 0 }',
      '.message-meta:hover, .message-meta:focus-within { opacity: 1 }',
    ])
  })

  it('measures the row spacing between glyphs and pills rather than between hit areas', async () => {
    // 28px boxes around 16px glyphs put 6px of invisible padding on each side of every icon, so the
    // row's own 8px gap rendered as 20px between glyphs, 14px to the usage pill and 8px to the time.
    // The boxes are 24px now and hand their 4px of padding back through a negative margin, which is
    // why the row carries the same 4px as inline padding: the first and last icons stay flush with
    // the message text. Any of these four numbers moving alone breaks the 8px rhythm.
    const styles = (await readRendererStyleSource()).replace(/\/\*[\s\S]*?\*\//gu, '')
    expect(styles).toMatch(/\.message-meta\s*\{[^}]*gap:\s*8px;[^}]*padding-inline:\s*4px;/u)
    expect(styles).toMatch(/\.message-meta-copy\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*min-height:\s*24px;[^}]*margin-inline:\s*-4px;/u)
    expect(styles).toMatch(/\.message-meta-branch\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*margin-inline:\s*-4px;/u)
    expect(styles).toMatch(/\.message-meta-copy\s+\.sidebar-svg-icon\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;/u)
    expect(styles).toMatch(/\.message-meta-branch\s+\.sidebar-svg-icon\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;/u)
  })
})
