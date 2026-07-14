import type { LittleSheepPlugin, PluginManifest } from '@littlesheep/plugins'
import { WebhookChannelPlugin, createWebhookPlugin } from './plugin.js'

export const pluginManifest: PluginManifest = {
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
}

export const littleSheepPlugin: LittleSheepPlugin = {
  manifest: pluginManifest,
  activate(context) {
    context.registerChannelType('webhook', createWebhookPlugin)
  },
}

export default littleSheepPlugin
export { WebhookChannelPlugin, createWebhookPlugin }
export { WebhookOptionsSchema, type WebhookOptions } from './options-schema.js'
