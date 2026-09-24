// External channel status payloads for the optional plugin layer.

export interface ChannelStatus {
  type: string
  displayName: string
  /**
   * Whether the plugin host is running this instance right now.
   *
   * `ChannelConnectionsStatus.channels` comes from `PluginHost.listChannels()`,
   * which reads the channel manager's running table — `stop()` removes the
   * entry, and a channel that failed to start is a `failures` entry instead. A
   * listed entry is therefore running by contract: pinned by the `list` cases
   * in `packages/plugins/src/channel/manager.test.ts` and measured in a real
   * window by `pnpm run verify:channel-entry-states`. The field stays on the
   * payload because the settings page must never treat "configured" or a
   * non-empty list as connection health — it counts running items.
   */
  running: boolean
  requiredSecrets: string[]
}

export interface ConfiguredChannel {
  id: string
  type: string
  enabled: boolean
  name?: string
}

export interface ChannelConnectionsStatus {
  started: boolean
  channels: ChannelStatus[]
  configured: ConfiguredChannel[]
  failures: Array<{ id: string; type: string; error: string }>
}
