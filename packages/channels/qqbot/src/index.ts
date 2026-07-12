// @littlesheep/channel-qqbot — public API
//
// QQ Bot channel plugin for the LittleSheep gateway. Receives messages via
// QQ Bot WebSocket gateway mode — no public callback URL needed.
// No SDK dependency — uses plain fetch() for HTTP API calls and the built-in
// global WebSocket (Node 22+) for the gateway connection.
//
// Usage:
//   import { createQqbotPlugin } from '@littlesheep/channel-qqbot';
//   channelManager.registerType('qqbot', createQqbotPlugin);
//
// Required secrets: QQBOT_APPID, QQBOT_APPSECRET

export {
  QqbotChannelPlugin,
  createQqbotPlugin,
  QQBOT_APPID_SECRET,
  QQBOT_APPSECRET_SECRET,
} from './plugin.js';
export { QqbotOptionsSchema, type QqbotOptions } from './options-schema.js';
