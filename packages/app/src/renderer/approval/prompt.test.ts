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
  it('renders inline Agent approval without a modal or conversation-wide Shell grant', () => {
    const markup = renderToStaticMarkup(createElement(ApprovalPromptSurface, { inline: true,
      prompt: { request: { id: 'inline', action: 'exec', permissionMode: 'research', permissionPreset: 'workspace-write', source: 'agent', boundary: 'unknown' }, resolve: () => undefined },
      onResolve: () => undefined }))
    expect(markup).toContain('role="region"')
    expect(markup).not.toContain('aria-modal')
    expect(markup).not.toContain('本对话允许')
    expect(markup).not.toContain('容器外')
    expect(markup).toContain('仅本次')
  })
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

  it('shows the exact-command repeat choice only when Main marks a fixed invocation eligible', () => {
    const command = {
      version: 1 as const,
      invocationId: 'invocation-pwd',
      digest: 'digest-pwd',
      action: 'exec' as const,
      command: 'pwd',
      shell: { path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoProfile', '-Command'], identity: 'shell-id' },
      cwd: { path: 'C:\\isolated-workspace', identity: 'workspace-directory-id' },
      workspace: { id: 'workspace:acceptance', path: 'C:\\isolated-workspace', identity: 'workspace-directory-id' },
      sessionId: 'session-acceptance',
      runId: 'run-acceptance',
      permission: 'permission-fingerprint',
      environment: 'environment-hmac',
      timeoutMs: 60_000,
      source: 'agent' as const,
      user: 'acceptance-user',
    }
    const markup = promptMarkup({
      id: 'approval-repeat-pwd',
      action: 'exec',
      detail: command,
      permissionMode: 'research',
      permissionPreset: 'workspace-write',
      source: 'agent',
      boundary: 'unknown',
      requiresExplicitUserApproval: true,
      rememberShellCommandAvailable: true,
      shellBatch: { version: 1, batchId: 'batch-pwd', scope: 'once', expiresAt: Date.now() + 120_000, commands: [command] },
    })

    expect(markup).toContain('<pre>pwd</pre>')
    expect(markup).toContain('本对话允许这条命令')
    expect(markup).toContain('最多再匹配 20 次或 30 分钟')
    expect(markup).toContain('没有 OS 级沙箱')
    expect(markup).toContain('工作区外文件、网络和子进程风险仍然存在')
    expect(markup).not.toMatch(/>本对话允许<\/button>/u)
    expect(markup).not.toContain('允许此类 Shell 命令')
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
