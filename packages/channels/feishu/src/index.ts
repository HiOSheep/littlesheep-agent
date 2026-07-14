import type { LittleSheepPlugin, PluginManifest } from '@littlesheep/plugins'
import { FeishuChannelPlugin, createFeishuPlugin } from './plugin.js'

export const pluginManifest: PluginManifest = {
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
}

export const littleSheepPlugin: LittleSheepPlugin = {
  manifest: pluginManifest,
  activate(context) {
    context.registerChannelType('feishu', createFeishuPlugin)
  },
}

export default littleSheepPlugin
export {
  FeishuChannelPlugin,
  createFeishuPlugin,
  FEISHU_APP_ID_SECRET,
  FEISHU_APP_SECRET_SECRET,
  FEISHU_VERIFICATION_TOKEN_SECRET,
  FEISHU_ENCRYPT_KEY_SECRET,
} from './plugin.js'
export { FeishuOptionsSchema, type FeishuOptions } from './options-schema.js'
