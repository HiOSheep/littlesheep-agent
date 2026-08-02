import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PinIcon, SendRunIcon, SidebarToggleIcon, StopRunIcon } from './icons'

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
