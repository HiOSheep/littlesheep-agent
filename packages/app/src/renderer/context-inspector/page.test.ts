import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, expect, it, vi } from 'vitest'
import { ContextInspectorPage } from './page'
import { ContextUsageIndicator } from '../composer/context-usage-indicator'
import { buildContextUsage } from '../context-usage'
vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

it('opens a meaningful empty Inspector and keeps missing counts unavailable', () => {
  const html = renderToStaticMarkup(createElement(ContextInspectorPage, { sessionId: null, modelRef: 'unknown/model', running: false, onClose() {} }))
  expect(html).toContain('尚未发送消息')
  expect(html).toContain('不可用')
  expect(html).toContain('返回聊天')
  expect(html).not.toContain('0 个含 Provider Usage')
})

it('exposes a native accessible ring button without changing occupancy', () => {
  const usage = buildContextUsage('unknown/model', null)
  const html = renderToStaticMarkup(createElement(ContextUsageIndicator, { usage, onOpen() {} }))
  expect(html).toContain('<button')
  expect(html).toContain('打开 Context Inspector')
  expect(html).toContain('stroke-dashoffset="100"')
  expect(usage.source).toBe('none')
})
