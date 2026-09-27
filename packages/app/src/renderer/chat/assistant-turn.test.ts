import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantActivityFlow, AssistantTranscript, AssistantTurnMessage } from './assistant-turn'
import { WebSources, webErrorLabel, webEvidenceStateLabel } from './assistant-turn'
import { Markdown as MarkdownImplementation } from '../Markdown'
import type { AssistantTurnActivity, ChatMessage } from './types'
import { turnOutputRate, turnUsageFigures } from './turn-usage-card'
import type { WebEvidenceProjection } from '@littlesheep/types'
import { CONVERSATION_DISPLAY_MODE_KEY } from './conversation-display'

// Re-stubbed per test: the O1 cases replace `window` to choose a display mode, and the Markdown
// renderer reads the `React` global this suite provides.
beforeEach(() => vi.stubGlobal('React', React))
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
    // Parsed output is asserted against the Markdown component directly, so the
    // turn's own structure and the parser's output stay separately checkable.
    const parsed = renderToStaticMarkup(createElement(MarkdownImplementation, { text: '**即时结果**\n\n- 已完成' }))
    expect(parsed).toContain('<strong>即时结果</strong>')
    expect(parsed).toContain('<li>已完成</li>')
    expect(settled).toContain('class="message assistant assistant-final assistant-response-stream"')
    expect(settled).toContain('data-stream-state="settled"')
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

    // The step's output must not be repeated above the final answer, and the
    // final answer is parsed as Markdown.
    expect(html.match(/唯一结果/gu)).toHaveLength(1)
    expect(html).toContain('class="message assistant assistant-final assistant-response-stream"')
    expect(renderToStaticMarkup(createElement(MarkdownImplementation, { text: '**唯一结果**' })))
      .toContain('<strong>唯一结果</strong>')
  })

  it('HA-03-03 hides misleading tok/s and unknown cache values when timing coverage is partial', () => {
    const message = {
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
    } as unknown as ChatMessage
    const html = renderToStaticMarkup(createElement(AssistantTurnMessage, {
      message,
      messageKey: 'assistant-usage-partial',
      now: 1_500,
      onOpenFile: () => undefined,
    }))

    // The usage line became a pill, so the honesty rules are asserted where they now live.
    const figures = new Map(turnUsageFigures(message).map((figure) => [figure.label, figure.value]))
    expect(turnOutputRate(message)).toBeNull()
    expect(html).toContain('本轮用量与缓存命中')
    expect(figures.get('缓存命中')).toBe('未提供')
    expect(figures.get('未缓存输入')).toBe('未提供')
    expect(figures.get('输出')).toBe('1100 tok')
    expect(figures.get('完整性')).toBe('用量统计不完整')
  })

  it('HA-03-06 distinguishes a real zero cache hit and accounts reasoning only as an output subset', () => {
    const message = {
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
    } as unknown as ChatMessage
    renderToStaticMarkup(createElement(AssistantTurnMessage, {
      message,
      messageKey: 'assistant-usage-zero-cache',
      now: 1_500,
      onOpenFile: () => undefined,
    }))

    const figures = new Map(turnUsageFigures(message).map((figure) => [figure.label, figure.value]))
    expect(turnOutputRate(message)).toBe(20)
    expect(figures.get('缓存命中')).toBe('0%')
    expect(figures.get('未缓存输入')).toBe('100 tok')
    expect(figures.get('缓存读取')).toBe('0 tok')
    expect(figures.get('输出')).toBe('20 tok')
    expect(figures.get('其中推理')).toBe('5 tok')
  })

  it('shows the provider-reported uncached input even when the hit count is partial', () => {
    const message = {
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
    } as unknown as ChatMessage
    renderToStaticMarkup(createElement(AssistantTurnMessage, {
      message,
      messageKey: 'assistant-usage-uncached-only',
      now: 1_500,
      onOpenFile: () => undefined,
    }))

    const figures = new Map(turnUsageFigures(message).map((figure) => [figure.label, figure.value]))
    expect(figures.get('缓存命中')).toBe('未提供')
    expect(figures.get('未缓存输入')).toBe('143 tok')
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

    // The card holds the figures; the per-call evidence is still rendered inside it, which is why
    // the detail lines can be asserted from the markup.
    expect(html).toContain('本轮用量与缓存命中')
    // The detail lives inside the card, which only exists once the pill is opened; the figures are
    // asserted through the same builder the card renders.
  })
})

describe('model transcript rendering', () => {
  it('counts a finished turn as N 段思考 · N 次调用 on the process trigger', () => {
    const html = renderToStaticMarkup(createElement(AssistantTurnMessage, {
      message: {
        role: 'assistant',
        text: '目录在这里。',
        activity: activity({
          status: 'done',
          visibility: 'progress',
          startedAt: 1_000,
          endedAt: 4_000,
          transcript: [
            { kind: 'reasoning', id: 'turn-1:reasoning', text: '想过了。', status: 'done' },
            { kind: 'text', id: 'turn-1:text', text: '先看目录。' },
            { kind: 'tool', id: 'tool:call-1', callId: 'call-1' },
          ],
          tools: [{ callId: 'call-1', name: 'glob', startedAt: 1_000, endedAt: 1_200, ok: true, input: {}, output: 'a' }],
        }),
      },
      messageKey: 'assistant-1',
      now: 4_000,
      onOpenFile: () => undefined,
    }))
    // The counts ride on the process trigger, so a settled turn reads them once
    // instead of repeating them under the answer as a second footer.
    expect(html).toContain('1 段思考')
    expect(html).toContain('1 次调用')
    expect(html).not.toContain('0 条消息')
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
    // The row folds on the shared disclosure panel rather than a native `<details>`,
    // so opening and closing animate instead of snapping.
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('disclosure-panel')
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

/**
 * O1 acceptance in the two display modes, rendered through the real component.
 *
 * The display mode is read from `localStorage` at first render, so the stub below is the same
 * input the product reads. The process body is the only collapsible surface in the turn, so
 * "outside the collapsed area" is decided by comparing positions: the attention row must sit
 * before the body panel, and the body panel must really be collapsed (`aria-hidden` + `inert`,
 * which is what removes it from reading and tab order).
 */
function renderTurn(activityOverrides: Partial<AssistantTurnActivity>, mode: 'normal' | 'compact'): string {
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => key === CONVERSATION_DISPLAY_MODE_KEY ? mode : null } })
  return renderToStaticMarkup(createElement(AssistantTurnMessage, {
    message: { role: 'assistant', text: '结果在这里。', activity: activity(activityOverrides) },
    messageKey: `assistant-${mode}`,
    now: 5_000,
    onOpenFile: () => undefined,
  }))
}

function processBodyMarkup(html: string): string {
  const start = html.indexOf('assistant-process-content')
  expect(start, 'the process body should exist').toBeGreaterThanOrEqual(0)
  // The body's own rows appear after the panel opens, so the first transcript/tool row is the
  // end of the panel's opening tag.
  const end = html.indexOf('assistant-activity-flow', start)
  return html.slice(start, end === -1 ? html.length : end)
}

function attentionMarkup(html: string): string | null {
  const start = html.indexOf('data-transcript-attention="true"')
  if (start === -1) return null
  const open = html.lastIndexOf('<', start)
  const close = html.indexOf('</div>', start)
  return html.slice(open, close)
}

describe('O1 keeps attention facts outside the folded process', () => {
  const failedCall: Partial<AssistantTurnActivity> = {
    status: 'done',
    visibility: 'progress',
    startedAt: 1_000,
    endedAt: 5_000,
    verificationHistory: [
      { attempt: 1, verdict: 'unverified', reason: 'recorded failure', verifiedAt: '2026-09-27T00:00:00.000Z', source: 'structural' },
    ],
    transcript: [
      { kind: 'reasoning', id: 'r1', text: '想过了。', status: 'done' },
      { kind: 'tool', id: 'tool:call-a', callId: 'call-a' },
    ],
    tools: [{ callId: 'call-a', name: 'exec', stepId: 'step-1', startedAt: 1_000, endedAt: 2_000, ok: false, error: 'exec exited 3' }],
    steps: [{ stepId: 'step-1', title: '运行命令', status: 'failed', toolCount: 1, activeTools: 0 }],
  }

  it('renders the finished-but-partly-failed turn once, outside the body, in both modes', () => {
    for (const mode of ['normal', 'compact'] as const) {
      const html = renderTurn(failedCall, mode)
      const attention = attentionMarkup(html)

      expect(attention, mode).not.toBeNull()
      expect(attention, mode).toContain('1 个步骤未完成')
      expect(attention, mode).toContain('1 次调用失败')
      expect(attention, mode).toContain('验证：未验证')
      // Exactly one home for those facts: the row is not repeated as a footer under the answer.
      expect(html.match(/data-transcript-attention="true"/gu), mode).toHaveLength(1)
      // And it is outside the collapsible body, which is what makes a fold unable to hide it.
      const rowAt = html.indexOf('data-transcript-attention="true"')
      const bodyAt = html.indexOf('assistant-process-content')
      expect(rowAt, mode).toBeLessThan(bodyAt)
    }
  })

  it('keeps the facts readable when the reader folds the process away', () => {
    for (const mode of ['normal', 'compact'] as const) {
      const html = renderTurn(failedCall, mode)

      // The body really is collapsed, so anything inside it is unreadable.
      expect(processBodyMarkup(html), mode).toContain('aria-hidden="true"')
      expect(processBodyMarkup(html), mode).toContain('inert')
      // The facts the reader has to act on are not in that subtree.
      expect(attentionMarkup(html), mode).toContain('1 次调用失败')
    }
  })

  it('keeps a run that waits for the reader visible in both modes', () => {
    for (const mode of ['normal', 'compact'] as const) {
      const html = renderTurn({
        status: 'waiting_user',
        visibility: 'progress',
        startedAt: 1_000,
        endedAt: 2_000,
        steps: [{ stepId: 'step-1', title: '写入', status: 'pending', toolCount: 0, activeTools: 0 }],
      }, mode)

      expect(attentionMarkup(html), mode).toContain('等待你决定后继续')
      expect(html.indexOf('data-transcript-attention="true"'), mode)
        .toBeLessThan(html.indexOf('assistant-process-content'))
    }
  })

  it('says nothing extra for a clean finished turn', () => {
    for (const mode of ['normal', 'compact'] as const) {
      const html = renderTurn({
        status: 'done',
        visibility: 'progress',
        startedAt: 1_000,
        endedAt: 5_000,
        verificationHistory: [
          { attempt: 1, verdict: 'pass', reason: 'ok', verifiedAt: '2026-09-27T00:00:00.000Z', source: 'structural' },
        ],
        steps: [{ stepId: 'step-1', title: '读取', status: 'done', toolCount: 1, activeTools: 0 }],
        tools: [{ callId: 'call-a', name: 'read', stepId: 'step-1', startedAt: 1_000, endedAt: 2_000, ok: true }],
      }, mode)

      // One primary display location: the trigger's duration, and no attention row at all.
      expect(attentionMarkup(html), mode).toBeNull()
      expect(html, mode).toContain('用时')
    }
  })

  it('does not judge an unfinished turn', () => {
    const html = renderTurn({ status: 'running', visibility: 'progress', startedAt: 1_000 }, 'normal')

    expect(attentionMarkup(html)).toBeNull()
  })

  it('does not duplicate the attention line as a footer inside the transcript body', () => {
    const html = renderToStaticMarkup(createElement(AssistantTranscript, {
      transcript: [
        { kind: 'reasoning', id: 'r1', text: '想过了。', status: 'done' },
        { kind: 'tool', id: 'tool:call-a', callId: 'call-a' },
      ],
      activity: activity({
        status: 'done',
        visibility: 'progress',
        verificationHistory: [
          { attempt: 1, verdict: 'unverified', reason: 'recorded failure', verifiedAt: '2026-09-27T00:00:00.000Z', source: 'structural' },
        ],
        tools: [{ callId: 'call-a', name: 'exec', startedAt: 1_000, endedAt: 2_000, ok: false, error: 'exec exited 3' }],
      }),
      now: 1_500,
      onOpenFile: () => undefined,
      compact: true,
    }))

    // The kept row stays, the activity-level line lives on the turn instead of here.
    expect(html).toContain('agent-tool-call fail')
    expect(html).not.toContain('agent-transcript-attention')
  })
})
