// @littlesheep/channel-telegram — public API
//
// Telegram channel plugin for the LittleSheep gateway. Receives messages via
// Telegram Bot API long polling (getUpdates). No SDK dependency — uses plain
// fetch() calls.
//
// Usage:
//   import { createTelegramPlugin } from '@littlesheep/channel-telegram';
//   channelManager.registerType('telegram', createTelegramPlugin);
//
// Required secret: TELEGRAM_BOT_TOKEN (in ChannelConfig.secrets).

export {
  TelegramChannelPlugin,
  createTelegramPlugin,
  TELEGRAM_BOT_TOKEN_SECRET,
} from './plugin.js';
export { TelegramOptionsSchema, type TelegramOptions } from './options-schema.js';
