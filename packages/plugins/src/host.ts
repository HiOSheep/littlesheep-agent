import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Config } from '@littlesheep/config'
import type { AgentRunner, LogFn } from '@littlesheep/runner'
import { loadSkillIndex, type SkillSourceDefinition } from '@littlesheep/skills'
import type { AgentTool } from '@littlesheep/types'
import { DefaultChannelManager, buildRuntimeConfig } from './channel/manager.js'
import { ChannelSessionStore } from './channel/session-binding.js'
import type { ChannelPlugin, ChannelPluginFactory } from './channel/types.js'
import { discoverLocalPluginSources } from './local-loader.js'
import {
  parsePluginManifest,
  pluginManifestsMatch,
  type LittleSheepPlugin,
  type PluginActivationContext,
  type PluginDiagnostic,
  type PluginManifest,
  type PluginSource,
  type PluginStatus,
} from './manifest.js'

interface PluginRecord {
  source: PluginSource
  state: PluginStatus['state']
  error?: string
  module?: LittleSheepPlugin
  channelTypes: Set<string>
  tools: Map<string, RegisteredPluginTool>
}

interface RegisteredPluginTool {
  tool: AgentTool
  registry: AgentRunner['infra']['registry']
}

export interface ChannelStartFailure {
  id: string
  type: string
  error: string
}

export interface CreatePluginHostOptions {
  runner: AgentRunner
  config: Config
  bindingsFile: string
  pluginInstallDir: string
  pluginDataDir: string
  builtinSources?: PluginSource[]
  log?: LogFn
}

export interface PluginHost {
  readonly started: boolean
  start(): Promise<void>
  stop(): Promise<void>
  reload(): Promise<void>
  setRunner(runner: AgentRunner): Promise<void>
  setConfig(config: Config): void
  listPlugins(): PluginStatus[]
  diagnostics(): PluginDiagnostic[]
  listChannels(): ChannelPlugin[]
  channelFailures(): ChannelStartFailure[]
}

export function createPluginHost(options: CreatePluginHostOptions): PluginHost {
  return new DefaultPluginHost(options)
}

class DefaultPluginHost implements PluginHost {
  private runner: AgentRunner
  private config: Config
  private readonly builtinSources: PluginSource[]
  private readonly pluginInstallDir: string
  private readonly pluginDataDir: string
  private readonly log: LogFn
  private readonly channelManager: DefaultChannelManager
  private records = new Map<string, PluginRecord>()
  private discoveryDiagnostics: PluginDiagnostic[] = []
  private startFailures = new Map<string, ChannelStartFailure>()
  private operation = Promise.resolve()
  private running = false

  constructor(options: CreatePluginHostOptions) {
    this.runner = options.runner
    this.config = options.config
    this.builtinSources = options.builtinSources ?? []
    this.pluginInstallDir = resolve(options.pluginInstallDir)
    this.pluginDataDir = resolve(options.pluginDataDir)
    this.log = options.log ?? (() => {})
    this.channelManager = new DefaultChannelManager({
      runner: this.runner,
      sessionStore: new ChannelSessionStore({ bindingsFile: options.bindingsFile }),
      log: this.log,
    })
  }

  get started(): boolean {
    return this.running
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.running) return
      await this.startInternal()
    })
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.stopInternal())
  }

  reload(): Promise<void> {
    return this.enqueue(async () => {
      await this.stopInternal()
      await this.startInternal()
    })
  }

  setRunner(runner: AgentRunner): Promise<void> {
    return this.enqueue(async () => {
      if (runner === this.runner) return
      this.runner = runner
      this.channelManager.setRunner(runner)

      for (const record of this.records.values()) {
        if (record.state !== 'active') continue
        const registrations = Array.from(record.tools.values())
        const attachedNames: string[] = []
        try {
          for (const registration of registrations) {
            runner.infra.registry.register(registration.tool, `plugin:${record.source.manifest.id}`)
            attachedNames.push(registration.tool.name)
          }
        } catch (error) {
          for (const name of attachedNames) runner.infra.registry.unregister(name)
          record.state = 'failed'
          record.error = `failed to attach tools to rebuilt runner: ${(error as Error).message}`
          this.log('error', `plugins: ${record.source.manifest.id}: ${record.error}`)
          continue
        }

        for (const registration of registrations) {
          registration.registry.unregister(registration.tool.name)
          registration.registry = runner.infra.registry
        }
      }
      await this.reconcileSkillContributions(runner)
    })
  }

  setConfig(config: Config): void {
    this.config = config
  }

  listPlugins(): PluginStatus[] {
    return Array.from(this.records.values())
      .map((record) => toPluginStatus(record, this.isEnabled(record.source.manifest.id)))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  }

  diagnostics(): PluginDiagnostic[] {
    return [...this.discoveryDiagnostics]
  }

  listChannels(): ChannelPlugin[] {
    return this.channelManager.list()
  }

  channelFailures(): ChannelStartFailure[] {
    return Array.from(this.startFailures.values())
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.operation.then(operation, operation)
    this.operation = next.catch(() => undefined)
    return next
  }

  private async startInternal(): Promise<void> {
    const startedAt = performance.now()
    await this.refreshSources()

    for (const record of this.records.values()) {
      const id = record.source.manifest.id
      if (!this.isEnabled(id)) {
        record.state = 'disabled'
        continue
      }
      if (record.source.kind === 'local' && !this.config.plugins.allowLocalCode) {
        record.state = 'blocked'
        record.error = '本地插件代码执行尚未获得用户信任'
        continue
      }
      if (!shouldActivate(record.source.manifest, this.config)) {
        record.state = 'inactive'
        continue
      }
      await this.activateRecord(record)
    }

    await this.reconcileSkillContributions(this.runner)
    await this.startConfiguredChannels()
    this.running = true
    this.log('info', `plugins: host started (${this.records.size} discovered, ${(performance.now() - startedAt).toFixed(1)}ms)`)
  }

  private async stopInternal(): Promise<void> {
    await this.channelManager.stopAll()
    const active = Array.from(this.records.values()).reverse()
    for (const record of active) await this.deactivateRecord(record)
    this.startFailures.clear()
    this.running = false
  }

  private async refreshSources(): Promise<void> {
    const extraDirs = this.config.plugins.extraDirs.map((path) => resolve(path))
    const discovered = await discoverLocalPluginSources([this.pluginInstallDir, ...extraDirs])
    this.discoveryDiagnostics = [...discovered.diagnostics]
    this.records.clear()

    for (const source of [...this.builtinSources, ...discovered.sources]) {
      let manifest: PluginManifest
      try {
        manifest = parsePluginManifest(source.manifest)
      } catch (error) {
        this.discoveryDiagnostics.push({
          source: source.location ?? source.manifest.id,
          message: `invalid plugin manifest: ${(error as Error).message}`,
        })
        continue
      }
      if (this.records.has(manifest.id)) {
        this.discoveryDiagnostics.push({
          source: source.location ?? manifest.id,
          message: `duplicate plugin id: ${manifest.id}`,
        })
        continue
      }
      this.records.set(manifest.id, {
        source: { ...source, manifest },
        state: 'inactive',
        channelTypes: new Set(),
        tools: new Map(),
      })
    }
  }

  private async activateRecord(record: PluginRecord): Promise<void> {
    const manifest = record.source.manifest
    record.state = 'activating'
    record.error = undefined
    try {
      await this.validateSkillContributions(record)
      const plugin = await record.source.load()
      const actualManifest = parsePluginManifest(plugin.manifest)
      if (!pluginManifestsMatch(manifest, actualManifest)) {
        throw new Error('loaded plugin manifest does not match the discovered manifest')
      }

      const dataDir = join(this.pluginDataDir, manifest.id)
      await mkdir(dataDir, { recursive: true })
      record.module = plugin
      await plugin.activate(this.activationContext(record, dataDir))
      record.state = 'active'
      this.log('info', `plugins: activated ${manifest.id}`)
    } catch (error) {
      record.state = 'failed'
      record.error = (error as Error).message
      await this.disposeContributions(record)
      this.log('error', `plugins: failed to activate ${manifest.id}: ${record.error}`)
    }
  }

  private activationContext(record: PluginRecord, dataDir: string): PluginActivationContext {
    const manifest = record.source.manifest
    return {
      pluginId: manifest.id,
      dataDir,
      registerChannelType: (type: string, factory: ChannelPluginFactory) => {
        requireContribution(manifest, 'channel', 'channels:register', type)
        this.channelManager.registerType(type, factory)
        record.channelTypes.add(type)
        let disposed = false
        return {
          dispose: () => {
            if (disposed) return
            disposed = true
            this.channelManager.unregisterType(type)
            record.channelTypes.delete(type)
          },
        }
      },
      registerTool: (tool: AgentTool) => {
        requireContribution(manifest, 'tool', 'tools:register', tool.name)
        const registration: RegisteredPluginTool = {
          tool,
          registry: this.runner.infra.registry,
        }
        registration.registry.register(tool, `plugin:${manifest.id}`)
        record.tools.set(tool.name, registration)
        let disposed = false
        return {
          dispose: () => {
            if (disposed) return
            disposed = true
            registration.registry.unregister(tool.name)
            record.tools.delete(tool.name)
          },
        }
      },
      log: (level, message) => this.log(level, `plugin:${manifest.id}: ${message}`),
    }
  }

  private async deactivateRecord(record: PluginRecord): Promise<void> {
    if (record.module?.deactivate) {
      try {
        await record.module.deactivate()
      } catch (error) {
        this.log('error', `plugins: deactivate failed for ${record.source.manifest.id}: ${(error as Error).message}`)
      }
    }
    await this.disposeContributions(record)
    record.module = undefined
    record.error = undefined
    record.state = this.isEnabled(record.source.manifest.id) ? 'inactive' : 'disabled'
  }

  private async validateSkillContributions(record: PluginRecord): Promise<void> {
    const declared = record.source.manifest.contributes.skills
    if (declared.length === 0) return
    const source = this.pluginSkillSource(record, true)
    if (!source) throw new Error('plugin skill contributions require a plugin source location')
    const index = await loadSkillIndex({ sources: [source] })
    const found = new Set(index.discovered.map((skill) => skill.name))
    const missing = declared.filter((name) => !found.has(name))
    if (missing.length > 0) {
      throw new Error(`declared plugin skills are missing or invalid: ${missing.join(', ')}`)
    }
  }

  private async reconcileSkillContributions(runner: AgentRunner): Promise<void> {
    let sources = this.pluginSkillSources()
    try {
      let index = await runner.infra.skillLoader.replaceOwnedSources('plugin', sources)
      let failed = false
      for (const record of this.records.values()) {
        if (record.state !== 'active' || record.source.manifest.contributes.skills.length === 0) continue
        const sourceId = `plugin:${record.source.manifest.id}`
        const entries = index.discovered.filter((skill) => skill.source.id === sourceId)
        const unavailable = record.source.manifest.contributes.skills.filter((name) => (
          !entries.some((skill) => skill.name === name && skill.availability === 'active')
        ))
        if (unavailable.length === 0) continue
        await this.failRecord(
          record,
          `skill contribution conflicts with another active skill or is unavailable: ${unavailable.join(', ')}`,
        )
        failed = true
      }
      if (failed) {
        sources = this.pluginSkillSources()
        index = await runner.infra.skillLoader.replaceOwnedSources('plugin', sources)
      }
      await runner.infra.memoryService.syncSkillResources(
        index.discovered.filter((skill) => skill.source.kind === 'plugin'),
        sources,
        { ownerKinds: ['plugin'] },
      )
    } catch (error) {
      const message = `failed to reconcile plugin skills: ${(error as Error).message}`
      this.log('error', `plugins: ${message}`)
      for (const record of this.records.values()) {
        if (record.state === 'active' && record.source.manifest.contributes.skills.length > 0) {
          await this.failRecord(record, message)
        }
      }
      sources = this.pluginSkillSources()
      try {
        const index = await runner.infra.skillLoader.replaceOwnedSources('plugin', sources)
        await runner.infra.memoryService.syncSkillResources(
          index.discovered.filter((skill) => skill.source.kind === 'plugin'),
          sources,
          { ownerKinds: ['plugin'] },
        )
      } catch (fallbackError) {
        this.log('error', `plugins: failed to persist disabled skill ownership: ${(fallbackError as Error).message}`)
      }
    }
  }

  private pluginSkillSources(): SkillSourceDefinition[] {
    return Array.from(this.records.values())
      .filter((record) => record.source.manifest.contributes.skills.length > 0)
      .flatMap((record) => {
        const source = this.pluginSkillSource(record, record.state === 'active')
        return source ? [source] : []
      })
  }

  private pluginSkillSource(record: PluginRecord, enabled: boolean): SkillSourceDefinition | undefined {
    if (!record.source.location) return undefined
    return {
      id: `plugin:${record.source.manifest.id}`,
      kind: 'plugin',
      ownerId: record.source.manifest.id,
      dir: join(record.source.location, 'skills'),
      enabled,
      include: [...record.source.manifest.contributes.skills],
    }
  }

  private async failRecord(record: PluginRecord, message: string): Promise<void> {
    if (record.module?.deactivate) {
      try {
        await record.module.deactivate()
      } catch (error) {
        this.log('error', `plugins: deactivate failed for ${record.source.manifest.id}: ${(error as Error).message}`)
      }
    }
    await this.disposeContributions(record)
    record.module = undefined
    record.state = 'failed'
    record.error = message
    this.log('error', `plugins: ${record.source.manifest.id}: ${message}`)
  }

  private async disposeContributions(record: PluginRecord): Promise<void> {
    for (const registration of record.tools.values()) {
      registration.registry.unregister(registration.tool.name)
    }
    record.tools.clear()
    for (const type of record.channelTypes) {
      try {
        this.channelManager.unregisterType(type)
      } catch (error) {
        this.log('error', `plugins: failed to unregister channel type ${type}: ${(error as Error).message}`)
      }
    }
    record.channelTypes.clear()
  }

  private async startConfiguredChannels(): Promise<void> {
    this.startFailures.clear()
    for (const channel of this.config.channels.channels.filter((entry) => entry.enabled)) {
      if (!this.channelManager.hasType(channel.type)) {
        const failure = {
          id: channel.id,
          type: channel.type,
          error: `channel type "${channel.type}" is not provided by an active plugin`,
        }
        this.startFailures.set(channel.id, failure)
        this.log('error', `plugins: ${failure.error}`)
        continue
      }
      try {
        const secrets = resolveChannelSecrets(channel.secrets, this.log)
        await this.channelManager.start(buildRuntimeConfig(channel, secrets))
      } catch (error) {
        const failure = { id: channel.id, type: channel.type, error: (error as Error).message }
        this.startFailures.set(channel.id, failure)
        this.log('error', `plugins: channel ${channel.id} failed: ${failure.error}`)
      }
    }
  }

  private isEnabled(pluginId: string): boolean {
    return !this.config.plugins.disabled.includes(pluginId)
  }
}

export function resolveChannelSecrets(secrets: Record<string, string>, log: LogFn): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(secrets)) {
    if (!value.startsWith('$')) {
      resolved[key] = value
      continue
    }
    const envName = value.slice(1)
    const envValue = process.env[envName]
    if (envValue) resolved[key] = envValue
    else log('warn', `channel: secret "${key}" references unset environment variable "${envName}"`)
  }
  return resolved
}

function shouldActivate(manifest: PluginManifest, config: Config): boolean {
  if (manifest.activationEvents.includes('onStartup')) return true
  const channelTypes = new Set(config.channels.channels.filter((entry) => entry.enabled).map((entry) => entry.type))
  return manifest.activationEvents.some((event) => {
    if (!event.startsWith('onChannel:')) return false
    return channelTypes.has(event.slice('onChannel:'.length))
  })
}

function requireContribution(
  manifest: PluginManifest,
  capability: 'channel' | 'tool',
  permission: 'channels:register' | 'tools:register',
  contribution: string,
): void {
  if (!manifest.capabilities.includes(capability)) {
    throw new Error(`plugin ${manifest.id} did not declare capability ${capability}`)
  }
  if (!manifest.permissions.includes(permission)) {
    throw new Error(`plugin ${manifest.id} did not declare permission ${permission}`)
  }
  const declared = capability === 'channel' ? manifest.contributes.channels : manifest.contributes.tools
  if (!declared.includes(contribution)) {
    throw new Error(`plugin ${manifest.id} did not declare contribution ${contribution}`)
  }
}

function toPluginStatus(record: PluginRecord, enabled: boolean): PluginStatus {
  const manifest = record.source.manifest
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    publisher: manifest.publisher,
    source: record.source.kind,
    location: record.source.location,
    enabled,
    state: record.state,
    capabilities: [...manifest.capabilities],
    permissions: [...manifest.permissions],
    activationEvents: [...manifest.activationEvents],
    contributes: {
      channels: [...manifest.contributes.channels],
      tools: [...manifest.contributes.tools],
      skills: [...manifest.contributes.skills],
    },
    error: record.error,
  }
}
