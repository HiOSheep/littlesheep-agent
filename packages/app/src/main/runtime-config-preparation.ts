// Config normalization shared by every entry that builds a Runner.
//
// Extracted from the composition root so the startup path and the bounded retry
// path normalize a config exactly the same way. Nothing here talks to Electron.

import {
  registerConfiguredModelCapabilities,
  resolveApiKey,
  selectDefaultModelForAvailableProvider,
  withProviderPresets,
  type Config,
  type ModelProvider,
} from '@littlesheep/config'
import { resolveRuntimeWorkspaceDefault } from './runtime-config.js'

export interface PreparedRuntimeConfig {
  config: Config
  model: string
  migratedDefaultWorkspace: boolean
}

function providerHasKey(provider: ModelProvider): boolean {
  return !provider.apiKey || !!resolveApiKey(provider.apiKey)
}

export function prepareRuntimeConfig(config: Config, workplaceDir?: string): PreparedRuntimeConfig {
  const prepared = withProviderPresets(config)
  const defaultWorkspace = prepared.agents.defaults.workspace
  const workspaceResolution = resolveRuntimeWorkspaceDefault(defaultWorkspace, workplaceDir)
  const workspace = workspaceResolution.workspace
  const normalized: Config = {
    ...prepared,
    agents: {
      ...prepared.agents,
      defaults: {
        ...prepared.agents.defaults,
        workspace,
      },
    },
  }
  const model = selectDefaultModelForAvailableProvider(normalized, providerHasKey)
  // User-declared model metadata is the only authority LS has for models the
  // built-in registry does not know; register it before the first run so that
  // context window, reasoning options and tokenizer honesty follow the config.
  registerConfiguredModelCapabilities(normalized)
  return { config: normalized, model, migratedDefaultWorkspace: workspaceResolution.migrated }
}
