import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AssistantActivityFlow, AssistantTurnMessage } from './assistant-turn'
import { WebSources, webErrorLabel, webEvidenceStateLabel } from './assistant-turn'
import type { AssistantTurnActivity, ChatMessage } from './types'
import type { WebEvidenceProjection } from '@littlesheep/types'

beforeAll(() => vi.stubGlobal('React', React))
afterAll(() => vi.unstubAllGlobals())


function activity(overrides: Partial<AssistantTurnActivity> = {}): AssistantTurnActivity {
  return {
    status: 'running',
    instruction: '检查工作区',
    startedAt: 100,
    steps: [],
    tools: [],
    ...overrides,
  }
}


function renderFlow(next: Partial<AssistantTurnActivity> = {}): string {
  return renderToStaticMarkup(createElement(AssistantActivityFlow, {
    activity: activity(next),
    now: 1_500,
    onOpenFile: () => undefined,
  }))
}


describe('assistant activity flow', () => {
  it('renders partial web evidence and stable safe error labels without exposing raw error ids', () => {
    const evidence: WebEvidenceProjection = {
      version: 1,
      generatedAt: '2026-08-29T00:00:00.000Z',
      completeness: 'partial',
      citationIds: ['web-ui-source'],
      citationCount: 1,
      documentCount: 1,
      cached: false,
      partial: true,
      truncated: true,
      blocked: false,
      stale: false,
      citations: [{
        id: 'web-ui-source',
        origin: 'https://example.com',
        urlHash: 'a'.repeat(64),
        title: 'Partial source',
        fetchedAt: '2026-08-29T00:00:00.000Z',
        status: 'partial',
        truncated: true,
      }],
      errorKinds: ['web_fetch_timeout', 'web_provider_rate_limited'],
    }
    const html = renderToStaticMarkup(createElement(WebSources, { evidence }))

    expect(webEvidenceStateLabel(evidence)).toBe('部分资料')
    expect(html).toContain('部分资料 · 1 项')
    expect(html).toContain('页面读取超时 · 搜索服务限流')
    expect(html).not.toContain('web_fetch_timeout')
    expect(html).not.toContain('web_provider_rate_limited')
    expect(html).not.toContain('token=')
  })

  it('maps every Runtime error category to a non-empty user-facing label', () => {
    const kinds = [
      'web_disabled', 'web_provider_unconfigured', 'web_provider_auth_failed', 'web_provider_rate_limited',
      'web_provider_unavailable', 'web_provider_invalid_response', 'web_invalid_query', 'web_sensitive_query_blocked',
      'web_url_invalid', 'web_scheme_blocked', 'web_ssrf_blocked', 'web_dns_check_failed', 'web_redirect_blocked',
      'web_fetch_timeout', 'web_fetch_cancelled', 'web_response_too_large', 'web_content_unsupported',
      'web_extraction_failed', 'web_cache_unavailable', 'web_partial', 'web_citation_invalid',
    ]
    expect(kinds.map(webErrorLabel)).not.toContain('网络资料读取失败')
  })

  it('renders a running step as soon as the first step event arrives', () => {
    const html = renderFlow({
      steps: [{
        stepId: 'step-1',
        title: '**扫描**项目文件',
        description: '查找相关入口',
        status: 'running',
        startedAt: 1_000,
        toolCount: 0,
        activeTools: 0,
      }],
    })

    expect(html).toContain('data-step-id="step-1"')
    expect(html).toContain('正在执行：**扫描**项目文件')
    expect(html).toContain('<strong>扫描</strong>项目文件')
    expect(html).toContain('agent-flow-row agent-step-row is-active')
  })

  it('shows the latest public reasoning phase and keeps its full trajectory directly visible', () => {
    const html = renderFlow({
      reasoning: [{
        phaseId: 'classify:2',
        stage: 'classify',
        summary: '已确定本轮处理路径',
        status: 'done',
        startedAt: 200,
        endedAt: 400,
      }, {
        phaseId: 'decide:3',
        stage: 'decide',
        summary: '正在校准目标、范围和验收标准',
        status: 'running',
        startedAt: 500,
      }],
    })

    expect(html).toContain('正在校准目标、范围和验收标准')
    expect(html).toContain('已确定本轮处理路径')
    expect(html).toContain('agent-reasoning-entry running')
    expect(html).toContain('aria-label="思考与执行判断轨迹"')
    expect(html).toContain('agent-reasoning-public-details')
    expect(html).not.toContain('agent-reasoning-toggle')
    expect(html).not.toContain('disclosure-panel')
  })

  it('renders a tool start as one compact row and preserves the row identity on completion', () => {
    const running = renderFlow({
      tools: [{
        callId: 'tool-1',
        name: 'read_file',
        input: { path: 'src/main.ts' },
        startedAt: 1_100,
      }],
    })
    const completed = renderFlow({
      status: 'done',
      tools: [{
        callId: 'tool-1',
        name: 'read_file',
        input: { path: 'src/main.ts' },
        startedAt: 1_100,
        endedAt: 1_300,
        ok: true,
        output: 'export const ready = true',
      }],
    })

    expect(running.match(/data-call-id="tool-1"/gu)).toHaveLength(1)
    expect(running).toContain('读取')
    expect(running).toContain('role="status"')
    expect(running).toContain('src/main.ts')
    expect(completed.match(/data-call-id="tool-1"/gu)).toHaveLength(1)
    expect(completed).not.toContain('agent-tool-call pending')
    expect(completed).toContain('agent-tool-call pass')
  })

  it('keeps streaming and settled replies in the same Markdown response surface', () => {
    const message = (status: 'running' | 'done'): ChatMessage => ({
      role: 'assistant',
      text: '**即时结果**\n\n- 已完成',
      activity: activity({ status }),
    })

    const streaming = renderToStaticMarkup(createElement(AssistantTurnMessage, {
      message: message('running'),
      messageKey: 'assistant-1',
      now: 1_500,
      onOpenFile: () => undefined,
    }))
    const settled = renderToStaticMarkup(createElement(AssistantTurnMessage, {
      message: message('done'),
      messageKey: 'assistant-1',
      now: 1_500,
      onOpenFile: () => undefined,
    }))

    expect(streaming).toContain('class="message assistant assistant-final assistant-response-stream"')
    expect(streaming).toContain('data-stream-state="streaming"')
    expect(streaming).toContain('<strong>即时结果</strong>')
    expect(streaming).toContain('<li>已完成</li>')
    expect(settled).toContain('class="message assistant assistant-final assistant-response-stream"')
    expect(settled).toContain('data-stream-state="settled"')
    expect(settled).toContain('<strong>即时结果</strong>')
  })

  it('does not repeat a completed step output above the final Markdown answer', () => {
    const html = renderToStaticMarkup(createElement(AssistantTurnMessage, {
      message: {
        role: 'assistant',
        text: '**唯一结果**',
        activity: activity({
          status: 'done',
          steps: [{
            stepId: 'step-1',
            title: '整理结果',
            status: 'done',
            output: '**唯一结果**',
            toolCount: 0,
            activeTools: 0,
          }],
        }),
      },
      messageKey: 'assistant-2',
      now: 1_500,
      onOpenFile: () => undefined,
    }))

    expect(html.match(/唯一结果/gu)).toHaveLength(1)
    expect(html).toContain('<strong>唯一结果</strong>')
  })
})
