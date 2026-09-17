import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AssistantActivityFlow, AssistantTranscript, AssistantTurnMessage } from './assistant-turn'
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

  it('keeps internal reasoning and task assessment out of the conversation area', () => {
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

    expect(html).toBe('')
  })

  it('shows only runtime-owned step and tool progress when explicitly disclosed', () => {
    const html = renderFlow({
      visibility: 'progress',
      steps: [{
        stepId: 'step-1',
        title: '读取文件',
        status: 'running',
        toolCount: 0,
        activeTools: 0,
      }],
      reasoning: [{
        phaseId: 'decide:1',
        stage: 'decide',
        summary: '内部判断不应显示',
        status: 'done',
        startedAt: 200,
      }],
      verificationHistory: [{
        verdict: 'pass',
        reason: '内部验收不应显示',
        attempt: 1,
        verifiedAt: '2026-09-02T00:00:00.000Z',
        source: 'structural',
      }],
    })

    expect(html).toContain('读取文件')
    expect(html).not.toContain('内部判断不应显示')
    expect(html).not.toContain('内部验收不应显示')
    expect(html).not.toContain('思考')
    expect(html).not.toContain('验证通过')
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

  it('HA-03-03 hides misleading tok/s and unknown cache values when timing coverage is partial', () => {
    const html = renderToStaticMarkup(createElement(AssistantTurnMessage, {
      message: {
        role: 'assistant',
        text: '完成',
        modelRef: 'deepseek/deepseek-flash',
        usage: {
          source: 'provider',
          promptTokens: 300,
          completionTokens: 1_100,
          totalTokens: 1_400,
          requestCount: 2,
          usageReportedRequestCount: 2,
          usageCompleteness: 'partial',
          timedRequestCount: 1,
          timedCompletionTokens: 100,
          providerDurationMs: 1_000,
          cacheReportedRequestCount: 0,
        },
        activity: activity({ status: 'done' }),
      },
      messageKey: 'assistant-usage-partial',
      now: 1_500,
      onOpenFile: () => undefined,
    }))

    expect(html).not.toContain('tok/s')
    expect(html).toContain('缓存命中 未提供')
    expect(html).toContain('未缓存输入 未提供')
    expect(html).toContain('输出 1100')
    expect(html).toContain('用量统计不完整')
  })

  it('HA-03-06 distinguishes a real zero cache hit and accounts reasoning only as an output subset', () => {
    const html = renderToStaticMarkup(createElement(AssistantTurnMessage, {
      message: {
        role: 'assistant',
        text: '完成',
        modelRef: 'deepseek/deepseek-flash',
        usage: {
          source: 'provider',
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
          cachedPromptTokens: 0,
          reasoningTokens: 5,
          requestCount: 1,
          usageReportedRequestCount: 1,
          usageCompleteness: 'complete',
          timedRequestCount: 1,
          timedCompletionTokens: 20,
          providerDurationMs: 1_000,
          cacheReportedRequestCount: 1,
        },
        activity: activity({ status: 'done' }),
      },
      messageKey: 'assistant-usage-zero-cache',
      now: 1_500,
      onOpenFile: () => undefined,
    }))

    expect(html).toContain('20.0 tok/s')
    expect(html).toContain('缓存命中 0%')
    expect(html).toContain('未缓存输入 100')
    expect(html).toContain('缓存读取 0')
    expect(html).toContain('输出 20')
    expect(html).toContain('其中推理 5')
  })

  it('shows the provider-reported uncached input even when the hit count is partial', () => {
    const html = renderToStaticMarkup(createElement(AssistantTurnMessage, {
      message: {
        role: 'assistant',
        text: '完成',
        modelRef: 'deepseek/deepseek-flash',
        usage: {
          source: 'provider',
          promptTokens: 1_807,
          completionTokens: 4,
          totalTokens: 1_811,
          uncachedPromptTokens: 143,
          requestCount: 1,
          usageReportedRequestCount: 1,
          usageCompleteness: 'complete',
          cacheReportedRequestCount: 0,
        },
        activity: activity({ status: 'done' }),
      },
      messageKey: 'assistant-usage-uncached-only',
      now: 1_500,
      onOpenFile: () => undefined,
    }))

    expect(html).toContain('缓存命中 未提供')
    expect(html).toContain('未缓存输入 143')
  })

  it('expands per-call cache evidence so a blended ratio explains itself', () => {
    const html = renderToStaticMarkup(createElement(AssistantTurnMessage, {
      message: {
        role: 'assistant',
        text: '完成',
        modelRef: 'deepseek/deepseek-flash',
        usage: {
          source: 'provider',
          promptTokens: 2_707,
          completionTokens: 8,
          cachedPromptTokens: 1_664,
          uncachedPromptTokens: 1_043,
          requestCount: 2,
          usageReportedRequestCount: 2,
          usageCompleteness: 'complete',
          cacheReportedRequestCount: 2,
        },
        cacheCalls: [
          {
            requestIndex: 1, stage: 'classify', status: 'miss',
            promptTokens: 900, cachedPromptTokens: 0, uncachedPromptTokens: 900, hitRatio: 0,
            reasons: ['tool_schema_changed'],
          },
          {
            requestIndex: 2, stage: 'execute', status: 'partial',
            promptTokens: 1_807, cachedPromptTokens: 1_664, uncachedPromptTokens: 143, hitRatio: 1_664 / 1_807,
            reasons: [],
          },
        ],
        cacheReasons: [{ reason: 'tool_schema_changed', count: 1 }],
        activity: activity({ status: 'done' }),
      },
      messageKey: 'assistant-usage-per-call',
      now: 1_500,
      onOpenFile: () => undefined,
    }))

    expect(html).toContain('缓存命中 61%')
    expect(html).toContain('逐调用缓存明细')
    expect(html).toContain('#1 classify · 未命中 0%')
    expect(html).toContain('未缓存 900')
    expect(html).toContain('#2 execute · 部分命中 92%')
    expect(html).toContain('原因 工具定义变更')
    expect(html).toContain('主要原因：工具定义变更×1')
    // The blended ratio mixes stages whose prompts differ; both views are shown.
    expect(html).toContain('主对话命中 92%（1 次）')
    expect(html).toContain('辅助阶段命中 0%（1 次）')
  })
})

describe('next-Harness transcript rendering', () => {
  it('summarises a finished turn as 已思考 · N 次工具调用 · N 条消息', () => {
    const html = renderToStaticMarkup(createElement(AssistantTranscript, {
      transcript: [
        { kind: 'reasoning', id: 'turn-1:reasoning', text: '想过了。', status: 'done' },
        { kind: 'text', id: 'turn-1:text', text: '先看目录。' },
        { kind: 'tool', id: 'tool:call-1', callId: 'call-1' },
      ],
      activity: activity({
        status: 'done',
        visibility: 'progress',
        durationMs: 2_400,
        tools: [{ callId: 'call-1', name: 'glob', startedAt: 1_000, endedAt: 1_200, ok: true, input: {}, output: 'a' }],
      }),
      now: 4_000,
      onOpenFile: () => undefined,
    }))
    expect(html).toContain('agent-transcript-summary')
    expect(html).toContain('已思考')
    expect(html).toContain('1 次工具调用')
    expect(html).toContain('1 条消息')
  })

  it('renders the system prompt row first and expandable', () => {
    const html = renderToStaticMarkup(createElement(AssistantTranscript, {
      transcript: [
        { kind: 'system', id: 'system-prompt', text: 'SOUL-AND-USER-PROMPT' },
        { kind: 'reasoning', id: 'reply:run:reasoning', text: '想好了。', status: 'done' },
      ],
      activity: activity({ visibility: 'progress' }),
      now: 1_500,
      onOpenFile: () => undefined,
    }))
    expect(html).toContain('系统提示词')
    expect(html).toContain('SOUL-AND-USER-PROMPT')
    expect(html.indexOf('系统提示词')).toBeLessThan(html.indexOf('想好了'))
    expect(html).toContain('<details')
  })

  it('renders thinking, prose, and tools in the order they were produced', () => {
    const html = renderToStaticMarkup(createElement(AssistantTranscript, {
      transcript: [
        { kind: 'reasoning', id: 'turn-1:reasoning', text: '先确认目录内容。', status: 'done' },
        { kind: 'text', id: 'turn-1:text', text: '我先列出目录。' },
        { kind: 'tool', id: 'tool:call-1', callId: 'call-1' },
        { kind: 'reasoning', id: 'turn-2:reasoning', text: '看到目录了，继续。', status: 'done' },
      ],
      activity: activity({
        visibility: 'progress',
        tools: [{
          callId: 'call-1',
          name: 'glob',
          startedAt: 1_000,
          endedAt: 1_200,
          ok: true,
          input: { pattern: '*' },
          output: 'attachments/',
        }],
      }),
      now: 1_500,
      onOpenFile: () => undefined,
    }))

    const thinking = html.indexOf('思考')
    const prose = html.indexOf('我先列出目录')
    const tool = html.indexOf('搜索')
    const later = html.indexOf('看到目录了')
    expect(thinking).toBeGreaterThanOrEqual(0)
    expect(prose).toBeGreaterThan(thinking)
    expect(tool).toBeGreaterThan(prose)
    expect(later).toBeGreaterThan(tool)
  })
})
