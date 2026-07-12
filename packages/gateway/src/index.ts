// @littlesheep/gateway — public API
//
// Phase 3: ChannelSessionStore for channel↔session binding persistence.
// Phase 4: ChannelPlugin interface, ChannelManager, ConversationPolicy.

// Channel session binding (Phase 3)
export { ChannelSessionStore, type ChannelBinding, type ChannelSessionStoreOptions } from './channel/session-binding.js';

// Channel plugin system (Phase 4)
export type {
  ChannelPlugin,
  ChannelPluginFactory,
  ChannelContext,
  ChannelRuntimeConfig,
  ChannelId,
  InboundChannelMessage,
  OutboundChannelMessage,
} from './channel/types.js';
export type { ChannelConfig, ConversationPolicy } from './channel/types.js';
export {
  DefaultChannelManager,
  buildRuntimeConfig,
  type ChannelManagerOptions,
} from './channel/manager.js';
export { evaluatePolicy, PairingState, type PolicyResult } from './channel/policy.js';

// Gateway service (Phase 6)
export {
  type GatewayService,
  type CreateGatewayServiceOptions,
  createGatewayService,
  resolveChannelSecrets,
} from './service.js';
