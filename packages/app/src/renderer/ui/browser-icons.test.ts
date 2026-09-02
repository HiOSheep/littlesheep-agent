import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { readRendererStyleSource } from '../style-source-test-utils'
import {
  BrowserBackIcon,
  BrowserForwardIcon,
  BrowserNewTabIcon,
  HistoryBackIcon,
  HistoryForwardIcon,
} from './browser-icons'

vi.stubGlobal('React', React)

describe('embedded browser icons', () => {
  it('uses the compact browser icon size and symmetric arrow paths', () => {
    const back = renderToStaticMarkup(React.createElement(BrowserBackIcon))
    const forward = renderToStaticMarkup(React.createElement(BrowserForwardIcon))
    const sharedBack = renderToStaticMarkup(React.createElement(HistoryBackIcon))
    const sharedForward = renderToStaticMarkup(React.createElement(HistoryForwardIcon))
    const newTab = renderToStaticMarkup(React.createElement(BrowserNewTabIcon))

    for (const icon of [back, forward, sharedBack, sharedForward]) {
      expect(icon).toContain('history-navigation-icon')
    }
    expect(newTab).toContain('workspace-browser-icon')
    expect(back).toContain('class="workspace-browser-arrow-shaft" d="M12.5 8H3.5"')
    expect(back).toContain('class="workspace-browser-arrow-head" d="m6.4 4.8-3.2 3.2 3.2 3.2"')
    expect(forward).toContain('class="workspace-browser-arrow-shaft" d="M3.5 8h9"')
    expect(forward).toContain('class="workspace-browser-arrow-head" d="m9.6 4.8 3.2 3.2-3.2 3.2"')
    expect(sharedBack).toBe(back)
    expect(sharedForward).toBe(forward)
  })

  it('keeps browser icon hover surfaces free of edge lines', async () => {
    const styles = await readRendererStyleSource()

    expect(styles).toMatch(/\.history-navigation-icon\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;/u)
    expect(styles).toMatch(/\.workspace-browser-nav \.history-nav-btn\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/u)
    expect(styles).toMatch(
      /\.workspace-browser-nav button:hover[^}]*,\s*\.workspace-browser-nav button:focus-visible,[\s\S]*?\.workspace-browser-toolbar button:focus-visible\s*\{[^}]*border:\s*0;[^}]*outline:\s*0;[^}]*box-shadow:\s*none;/u,
    )
  })
})
