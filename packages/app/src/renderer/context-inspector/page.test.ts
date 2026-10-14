import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, expect, it, vi } from 'vitest'
import { ContextInspectorPage, SessionOverview } from './page'
import { ContextUsageIndicator } from '../composer/context-usage-indicator'
import { buildContextUsage } from '../context-usage'
vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

it('opens a meaningful empty Inspector and keeps missing counts unavailable', () => {
  const html = renderToStaticMarkup(createElement(ContextInspectorPage, { sessionId: null, modelRef: 'unknown/model', running: false }))
  expect(html).toContain('尚未发送消息')
  expect(html).toContain('不可用')
  expect(html).toContain('会话总览')
  expect(html).not.toContain('返回聊天') // Navigation belongs to the shared workspace tab strip.
  expect(html).not.toContain('0 个含 Provider Usage')
})

it('shows session overview without explanatory small text and keeps request details behind a trajectory entry', () => {
  const html = renderToStaticMarkup(createElement(SessionOverview, {
    data: { version: 1, sessionId: 'session', coverage: 'loaded_history', requests: [], retainedRequests: 0, truncated: false, active: false,
      session: { title: '测试会话', createdAt: 0, lastMessageAt: 1000 } },
    sessionId: 'session', modelRef: 'unknown/model', running: false, pending: false, onSelect() {},
  }))
  expect(html).toContain('测试会话')
  expect(html).toContain('会话累计 Token')
  expect(html).toContain('请求轨迹')
  expect(html).not.toContain('<small>')
  expect(html).not.toContain('上下文构成')
  const stale = renderToStaticMarkup(createElement(SessionOverview, {
    data: { version: 1, sessionId: 'other', coverage: 'loaded_history', requests: [], retainedRequests: 0, truncated: false, active: false,
      session: { title: '不可泄漏' } }, sessionId: 'session', running: false, pending: false, onSelect() {},
  }))
  expect(stale).not.toContain('不可泄漏')
})

it('exposes a native accessible ring button without changing occupancy', () => {
  const usage = buildContextUsage('unknown/model', null)
  const html = renderToStaticMarkup(createElement(ContextUsageIndicator, { usage, onOpen() {} }))
  expect(html).toContain('<button')
  expect(html).toContain('打开 Context Inspector')
  expect(html).toContain('stroke-dashoffset="100"')
  expect(usage.source).toBe('none')
})
