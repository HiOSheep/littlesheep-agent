// Optional plugin host startup, loaded only when execution starts.
//
// The plugin package pulls in every built-in channel implementation, and the
// desktop window no longer waits for execution to begin. Keeping this import
// out of the main entry's static graph keeps that module evaluation off the path
// that runs before the first business log.

import type { Config } from '@littlesheep/config'
import { dataSubdirs, type BrandingConfig } from '@littlesheep/branding'
import type { AgentRunner, LogFn } from '@littlesheep/runner'
import { createPluginHost, type PluginHost } from '@littlesheep/plugins'
import { join } from 'node:path'
import { BUILTIN_PLUGIN_SOURCES } from './builtin-plugins.js'

export interface StartPluginHostInput {
  runner: AgentRunner
  branding: BrandingConfig
  config: Config
}

export function startPluginHost(input: StartPluginHostInput): PluginHost {
  const dirs = dataSubdirs(input.branding)
  const host = createPluginHost({
    runner: input.runner,
    bindingsFile: join(dirs.channels, 'bindings.json'),
    pluginInstallDir: dirs.plugins,
    pluginDataDir: dirs.pluginData,
    config: input.config,
    builtinSources: BUILTIN_PLUGIN_SOURCES,
    log: ((level: 'info' | 'warn' | 'error', msg: string) =>
      console.log(`[plugins:${level}] ${msg}`)) as LogFn,
  })
  void host.start().catch((error) => {
    console.error('[plugins] host failed to start:', error)
  })
  return host
}
