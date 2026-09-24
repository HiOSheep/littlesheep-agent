import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { ChannelConnectionsStatus } from '../shared/channel-control-contracts'
import { summarizeChannelConnections } from './channel-status'

function status(overrides: Partial<ChannelConnectionsStatus> = {}): ChannelConnectionsStatus {
  return {
    started: true,
    channels: [],
    configured: [],
    failures: [],
    ...overrides,
  }
}

const loaded = (id: string, running: boolean) => ({
  type: id,
  displayName: id,
  running,
  requiredSecrets: [],
})

const configured = (id: string, enabled = true) => ({ id, type: id, enabled, name: id })
const failure = (id: string) => ({ id, type: id, error: '缺少密钥' })

describe('channel connection summary', () => {
  it('reports an unconfigured state only when nothing is configured or loaded', () => {
    const overall = summarizeChannelConnections(status())

    expect(overall).toMatchObject({ kind: 'unconfigured', label: '未配置外部渠道', counts: '' })
    expect(overall.runningCount).toBe(0)
  })

  it('reports running only when every loaded channel is running and none failed', () => {
    const overall = summarizeChannelConnections(status({
      channels: [loaded('webhook', true), loaded('telegram', true)],
      configured: [configured('webhook'), configured('telegram')],
    }))

    expect(overall).toMatchObject({
      kind: 'running',
      label: '外部渠道运行中',
      counts: '运行 2/2 · 已配置 2',
      runningCount: 2,
      loadedCount: 2,
    })
  })

  it('does not call a configured but stopped channel healthy', () => {
    const overall = summarizeChannelConnections(status({
      channels: [loaded('webhook', false)],
      configured: [configured('webhook'), configured('telegram', false)],
    }))

    expect(overall).toMatchObject({
      kind: 'stopped',
      label: '外部渠道未运行',
      counts: '运行 0/1 · 已配置 2',
      runningCount: 0,
      enabledCount: 1,
    })
  })

  it('reports partial running with the failure count when some channels failed', () => {
    const overall = summarizeChannelConnections(status({
      channels: [loaded('webhook', true), loaded('telegram', false)],
      configured: [configured('webhook'), configured('telegram'), configured('feishu')],
      failures: [failure('telegram')],
    }))

    expect(overall).toMatchObject({
      kind: 'partial',
      label: '部分渠道运行中',
      counts: '运行 1/2 · 已配置 3 · 失败 1',
      failureCount: 1,
    })
    expect(overall.detail).toContain('1 项启动失败')
  })

  it('keeps failures visible when nothing is running', () => {
    const overall = summarizeChannelConnections(status({
      channels: [loaded('webhook', false)],
      configured: [configured('webhook')],
      failures: [failure('webhook')],
    }))

    expect(overall).toMatchObject({ kind: 'stopped', label: '外部渠道未运行', counts: '运行 0/1 · 已配置 1 · 失败 1' })
    expect(overall.detail).toContain('当前没有渠道在运行')
    expect(overall.detail).toContain('1 项启动失败')
  })

  it('states the configuration facts when every configured channel is disabled', () => {
    // The reachable "all stopped" fixture: the channel is configured but
    // disabled, so nothing was started, nothing is loaded and nothing failed.
    // The sentence must describe that instead of calling a never-started
    // channel "未运行" (measured in a real window by verify:channel-entry-states).
    const overall = summarizeChannelConnections(status({
      configured: [configured('webhook', false)],
    }))

    expect(overall).toMatchObject({
      kind: 'stopped',
      label: '外部渠道未运行',
      counts: '运行 0/0 · 已配置 1',
      loadedCount: 0,
      runningCount: 0,
      enabledCount: 0,
    })
    expect(overall.detail).toContain('已配置 1 个渠道（0 个启用）')
    expect(overall.detail).toContain('当前没有渠道在运行')
    expect(overall.detail).not.toContain('全部未运行')
  })

  it('never counts a stopped channel as running in the detail sentence', () => {
    const overall = summarizeChannelConnections(status({
      channels: [loaded('webhook', true), loaded('telegram', true), loaded('feishu', false)],
      configured: [configured('webhook'), configured('telegram'), configured('feishu')],
    }))

    expect(overall.kind).toBe('partial')
    expect(overall.runningCount).toBe(2)
    expect(overall.detail).toContain('只有 2 个在运行')
  })
})

describe('channel status wiring', () => {
  it('drives the badge and the list heading from the shared summary', async () => {
    const source = await readFile(new URL('./ChannelConnections.tsx', import.meta.url), 'utf8')

    expect(source).toContain('const overall = status ? summarizeChannelConnections(status) : null')
    expect(source).toContain('{!loading && status && overall && (')
    expect(source).toContain('className={`channel-badge ${overall.kind}`}')
    expect(source).toContain('title={overall.detail}')
    expect(source).toContain('已加载渠道 ({status.channels.length})')
    // A loaded entry with running=false must not be described as running.
    expect(source).not.toContain('运行中的渠道')
    expect(source).not.toContain("status.channels.length > 0 ? 'running' : 'stopped'")
    expect(source).toContain("{ch.running ? '运行中' : '未运行'}")
  })
})
