import type { LittleSheepPlugin, PluginManifest } from '@littlesheep/plugins'
import { createTelegramPlugin } from './plugin.js'

export const pluginManifest: PluginManifest = {
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
}

export const littleSheepPlugin: LittleSheepPlugin = {
  manifest: pluginManifest,
  activate(context) {
    context.registerChannelType('telegram', createTelegramPlugin)
  },
}

export default littleSheepPlugin
export {
  TelegramChannelPlugin,
  createTelegramPlugin,
  TELEGRAM_BOT_TOKEN_SECRET,
} from './plugin.js'
export { TelegramOptionsSchema, type TelegramOptions } from './options-schema.js'
