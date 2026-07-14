// Plugin control-plane payloads shared with the renderer.

import type { PluginDiagnostic, PluginRuntimeState, PluginStatus } from '@littlesheep/plugins'

export type { PluginDiagnostic, PluginRuntimeState, PluginStatus }

export interface PluginsStatusResponse {
  started: boolean
  allowLocalCode: boolean
  plugins: PluginStatus[]
  diagnostics: PluginDiagnostic[]
}
