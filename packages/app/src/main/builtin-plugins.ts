import {
  parsePluginManifest,
  type LittleSheepPlugin,
  type PluginManifest,
  type PluginSource,
} from '@littlesheep/plugins'

type PluginNamespace = { littleSheepPlugin?: LittleSheepPlugin; default?: LittleSheepPlugin }

export const BUILTIN_PLUGIN_SOURCES: PluginSource[] = [
  builtinChannelSource({
    id: 'littlesheep.channel.webhook',
    name: 'Webhook 渠道',
    version: '0.1.0',
    apiVersion: 1,
    description: '通过本机 HTTP Webhook 接入外部消息。',
    publisher: 'LittleSheep',
    capabilities: ['channel'],
    permissions: ['agent:run', 'channels:register', 'network', 'secrets'],
    activationEvents: ['onChannel:webhook'],
    contributes: { channels: ['webhook'], tools: [], skills: [] },
  }, () => import('@littlesheep/channel-webhook')),
  builtinChannelSource({
    id: 'littlesheep.channel.telegram',
    name: 'Telegram 渠道',
    version: '0.1.0',
    apiVersion: 1,
    description: '通过 Telegram Bot API 收发消息。',
    publisher: 'LittleSheep',
    capabilities: ['channel'],
    permissions: ['agent:run', 'channels:register', 'network', 'secrets'],
    activationEvents: ['onChannel:telegram'],
    contributes: { channels: ['telegram'], tools: [], skills: [] },
  }, () => import('@littlesheep/channel-telegram')),
  builtinChannelSource({
    id: 'littlesheep.channel.feishu',
    name: '飞书渠道',
    version: '0.1.0',
    apiVersion: 1,
    description: '通过飞书长连接收发消息。',
    publisher: 'LittleSheep',
    capabilities: ['channel'],
    permissions: ['agent:run', 'channels:register', 'network', 'secrets'],
    activationEvents: ['onChannel:feishu'],
    contributes: { channels: ['feishu'], tools: [], skills: [] },
  }, () => import('@littlesheep/channel-feishu')),
  builtinChannelSource({
    id: 'littlesheep.channel.qqbot',
    name: 'QQ Bot 渠道',
    version: '0.1.0',
    apiVersion: 1,
    description: '通过 QQ Bot WebSocket 网关收发消息。',
    publisher: 'LittleSheep',
    capabilities: ['channel'],
    permissions: ['agent:run', 'channels:register', 'network', 'secrets'],
    activationEvents: ['onChannel:qqbot'],
    contributes: { channels: ['qqbot'], tools: [], skills: [] },
  }, () => import('@littlesheep/channel-qqbot')),
]

function builtinChannelSource(
  manifestInput: PluginManifest,
  loadNamespace: () => Promise<PluginNamespace>,
): PluginSource {
  const manifest = parsePluginManifest(manifestInput)
  return {
    kind: 'builtin',
    manifest,
    async load() {
      const namespace = await loadNamespace()
      const plugin = namespace.littleSheepPlugin ?? namespace.default
      if (!plugin) throw new Error(`built-in plugin ${manifest.id} has no plugin export`)
      return plugin
    },
  }
}
