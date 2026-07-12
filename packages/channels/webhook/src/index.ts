// @littlesheep/channel-webhook — public API
//
// Webhook channel plugin for the LittleSheep gateway. Receives messages via
// HTTP POST on 127.0.0.1 (loopback only). No SDK dependency — the simplest
// channel, useful for end-to-end testing and automation integrations.
//
// Usage:
//   import { createWebhookPlugin } from '@littlesheep/channel-webhook';
//   channelManager.registerType('webhook', createWebhookPlugin);

export { WebhookChannelPlugin, createWebhookPlugin } from './plugin.js';
export { WebhookOptionsSchema, type WebhookOptions } from './options-schema.js';
