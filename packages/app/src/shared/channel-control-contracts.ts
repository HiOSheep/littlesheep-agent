// External channel status payloads for the optional plugin layer.

export interface ChannelStatus {
  type: string
  displayName: string
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
