import type { ChannelConnectionsStatus, PluginStatus } from '../api'

/** Loading permission and live channel health are separate host facts. */
export function pluginConnectionLabel(plugin: PluginStatus, connections: ChannelConnectionsStatus | null): string | null {
  const types = plugin.contributes.channels
  if (!plugin.enabled || plugin.state === 'failed' || plugin.state === 'blocked' || types.length === 0) return null
  if (!connections) return '连接状态未读取'
  if (connections.failures.some((item) => types.includes(item.type))) return '渠道连接失败'
  const running = connections.channels.filter((item) => types.includes(item.type) && item.running).length
  if (running > 0) return `${running} 个渠道运行中`
  const configured = connections.configured.filter((item) => types.includes(item.type))
  if (configured.length === 0) return '渠道未配置'
  if (configured.every((item) => !item.enabled)) return '渠道已停用'
  return '渠道已配置 · 未运行'
}
