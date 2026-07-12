// @littlesheep/channel-feishu — public API
//
// Feishu channel plugin for the LittleSheep gateway. Receives messages via
// Feishu long connection (WebSocket) mode — no public callback URL needed.
// No SDK dependency — uses plain fetch() + built-in WebSocket (Node 22+).
//
// Usage:
//   import { createFeishuPlugin } from '@littlesheep/channel-feishu';
//   channelManager.registerType('feishu', createFeishuPlugin);
//
// Required secrets: FEISHU_APP_ID, FEISHU_APP_SECRET
// Optional secrets: FEISHU_VERIFICATION_TOKEN, FEISHU_ENCRYPT_KEY

export {
  FeishuChannelPlugin,
  createFeishuPlugin,
  FEISHU_APP_ID_SECRET,
  FEISHU_APP_SECRET_SECRET,
  FEISHU_VERIFICATION_TOKEN_SECRET,
  FEISHU_ENCRYPT_KEY_SECRET,
} from './plugin.js';
export { FeishuOptionsSchema, type FeishuOptions } from './options-schema.js';
