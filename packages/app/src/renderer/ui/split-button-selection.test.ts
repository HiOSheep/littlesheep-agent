import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SplitButton } from './split-button'

describe('split button selection', () => {
  beforeAll(() => vi.stubGlobal('React', React))
  afterAll(() => vi.unstubAllGlobals())
  it('uses the current option icon instead of a generic fallback', () => {
    const markup = renderToStaticMarkup(createElement(SplitButton, {
      icon: createElement('span', {}, 'fallback-folder'), label: '打开方式：WorkBuddy', primaryTip: '用 WorkBuddy 打开', menuLabel: '选择打开方式', onPrimary: () => undefined,
      items: [{ id: 'buddy', label: 'WorkBuddy', active: true, icon: createElement('img', { src: 'data:image/png;base64,YQ==', alt: '' }), onSelect: () => undefined }],
    }))
    expect(markup).toContain('打开方式：WorkBuddy')
    expect(markup).toContain('src="data:image/png;base64,YQ=="')
    expect(markup).not.toContain('fallback-folder')
  })
  it('does not display a disabled option as the current selection', () => {
    const markup = renderToStaticMarkup(createElement(SplitButton, {
      icon: createElement('span', {}, 'available-target'), label: '可用目标', primaryTip: '可用目标', menuLabel: '选择目标', onPrimary: () => undefined,
      items: [{ id: 'missing', label: '不可用', active: true, disabled: true, icon: createElement('span', {}, 'missing-target'), onSelect: () => undefined }],
    }))
    expect(markup).toContain('available-target')
    expect(markup).not.toContain('missing-target')
  })
})
