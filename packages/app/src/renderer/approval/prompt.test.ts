import { afterAll, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { approvalActionRiskDescription, ApprovalPromptSurface } from './prompt'
import type { PendingApprovalPrompt } from './types'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

function promptMarkup(request: PendingApprovalPrompt['request']): string {
  return renderToStaticMarkup(createElement(ApprovalPromptSurface, {
    prompt: { request, resolve: () => undefined },
    onResolve: () => undefined,
  }))
}

describe('approval prompt scope', () => {
  it('offers only deny and once for V2 Agent Shell approvals', () => {
    const markup = promptMarkup({
      id: 'approval-v2-exec',
      action: 'exec',
      permissionMode: 'research',
      permissionPreset: 'workspace-write',
      source: 'agent',
      boundary: 'unknown',
    })

    expect(markup).toContain('拒绝')
    expect(markup).toContain('仅本次')
    expect(markup).not.toContain('本对话允许')
  })

  it('does not offer a reusable grant for Main-forced approvals', () => {
    const markup = promptMarkup({
      id: 'approval-forced',
      action: 'write',
      permissionMode: 'full',
      requiresExplicitUserApproval: true,
      source: 'agent',
      boundary: 'inside',
    })

    expect(markup).toContain('仅本次')
    expect(markup).not.toContain('本对话允许')
  })

  it('keeps session grants for ordinary legacy approvals', () => {
    const markup = promptMarkup({
      id: 'approval-legacy',
      action: 'write',
      permissionMode: 'research',
      source: 'agent',
      boundary: 'inside',
    })

    expect(markup).toContain('本对话允许')
  })
})

describe('approvalActionRiskDescription', () => {
  it('identifies approved Agent commands as host execution without OS isolation', () => {
    const description = approvalActionRiskDescription('exec', 'agent')

    expect(description).toContain('宿主环境运行')
    expect(description).toContain('没有为 Agent Shell 提供操作系统级沙箱')
    expect(description).toContain('工作区边界不会限制该命令')
    expect(description).toContain('其他文件、启动本地进程或使用网络')
  })

  it('keeps non-shell approval explanations scoped to their existing action', () => {
    const description = approvalActionRiskDescription('write', 'agent')

    expect(description).toContain('修改所示文件')
    expect(description).not.toContain('宿主环境运行')
  })

  it('describes workspace terminal commands without mislabeling them as Agent calls', () => {
    const description = approvalActionRiskDescription('exec', 'workspace')

    expect(description).toContain('你的交互式终端中以当前用户权限运行')
    expect(description).toContain('不会为该终端命令提供操作系统级沙箱')
    expect(description).not.toContain('Agent Shell')
  })
})
