import { describe, expect, it } from 'vitest'
import { environmentVersionDisplay } from './environment-version-display'
import { pluginConnectionLabel } from './plugin-connection-label'
import type { ChannelConnectionsStatus, PluginStatus } from '../api'
const plugin = { enabled: true, state: 'inactive', contributes: { channels: ['telegram'] } } as PluginStatus
const empty: ChannelConnectionsStatus = { started: true, channels: [], configured: [], failures: [] }
describe('configuration and live status remain distinct', () => {
  it('does not call an enabled plugin a running connection', () => {
    expect(pluginConnectionLabel(plugin, empty)).toBe('渠道未配置')
    expect(pluginConnectionLabel(plugin, null)).toBe('连接状态未读取')
    expect(pluginConnectionLabel(plugin, { ...empty, configured: [{ id: 'a', type: 'telegram', enabled: true }] })).toBe('渠道已配置 · 未运行')
    expect(pluginConnectionLabel(plugin, { ...empty, configured: [{ id: 'a', type: 'telegram', enabled: false }] })).toBe('渠道已停用')
  })
  it('uses matching channel facts and keeps failures visible', () => {
    const running = { type: 'telegram', displayName: 'test', running: true, requiredSecrets: [] }
    expect(pluginConnectionLabel(plugin, { ...empty, channels: [running] })).toBe('1 个渠道运行中')
    expect(pluginConnectionLabel(plugin, { ...empty, channels: [{ ...running, type: 'other' }] })).toBe('渠道未配置')
    expect(pluginConnectionLabel(plugin, { ...empty, channels: [running], failures: [{ id: 'b', type: 'telegram', error: 'failed' }] })).toBe('渠道连接失败')
    expect(pluginConnectionLabel({ ...plugin, state: 'failed' }, empty)).toBeNull()
    expect(pluginConnectionLabel({ ...plugin, enabled: false }, empty)).toBeNull()
  })
})
describe('toolchain version presentation', () => {
  it('shows real versions, including common executable prefixes', () => {
    for (const value of ['v24.21.0', '3.12.10', 'git version 2.50.1.windows.1', 'Python 3.12.10', 'rustc 1.90.0 (hash)', 'go version go1.25.0 windows/amd64']) expect(environmentVersionDisplay(value).label).toBe(value)
  })
  it('keeps a command failure out of the version value and retains its diagnostic', () => {
    const value = 'The command could not be loaded, possibly because:'
    expect(environmentVersionDisplay(value)).toEqual({ label: '检测未成功', diagnostic: value })
    expect(environmentVersionDisplay(null)).toEqual({ label: '未发现' })
  })
})
