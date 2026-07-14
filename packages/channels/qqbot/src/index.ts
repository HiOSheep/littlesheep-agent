import type { LittleSheepPlugin, PluginManifest } from '@littlesheep/plugins'
import { QqbotChannelPlugin, createQqbotPlugin } from './plugin.js'

export const pluginManifest: PluginManifest = {
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
}

export const littleSheepPlugin: LittleSheepPlugin = {
  manifest: pluginManifest,
  activate(context) {
    context.registerChannelType('qqbot', createQqbotPlugin)
  },
}

export default littleSheepPlugin
export {
  QqbotChannelPlugin,
  createQqbotPlugin,
  QQBOT_APPID_SECRET,
  QQBOT_APPSECRET_SECRET,
} from './plugin.js'
export { QqbotOptionsSchema, type QqbotOptions } from './options-schema.js'
