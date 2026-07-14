// @littlesheep/plugins - public plugin SDK and runtime host.

export {
  PLUGIN_API_VERSION,
  PluginCapabilitySchema,
  PluginActivationEventSchema,
  PluginPermissionSchema,
  PluginManifestSchema,
  parsePluginManifest,
  pluginManifestsMatch,
  type LittleSheepPlugin,
  type PluginActivationContext,
  type PluginCapability,
  type PluginDiagnostic,
  type PluginDisposable,
  type PluginManifest,
  type PluginPermission,
  type PluginRuntimeState,
  type PluginSource,
  type PluginStatus,
} from './manifest.js'

export {
  discoverLocalPluginSources,
  type LocalPluginDiscoveryResult,
} from './local-loader.js'

export {
  createPluginHost,
  resolveChannelSecrets,
  type ChannelStartFailure,
  type CreatePluginHostOptions,
  type PluginHost,
} from './host.js'

export type {
  ChannelPlugin,
  ChannelPluginFactory,
  ChannelContext,
  ChannelRuntimeConfig,
  ChannelId,
  InboundChannelMessage,
  OutboundChannelMessage,
} from './channel/types.js'
export type { ChannelConfig, ConversationPolicy } from './channel/types.js'
export {
  DefaultChannelManager,
  buildRuntimeConfig,
  type ChannelManagerOptions,
} from './channel/manager.js'
export { ChannelSessionStore, type ChannelBinding, type ChannelSessionStoreOptions } from './channel/session-binding.js'
export { evaluatePolicy, PairingState, type PolicyResult } from './channel/policy.js'
export { abortableDelay } from './channel/lifecycle.js'
