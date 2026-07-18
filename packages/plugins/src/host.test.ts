import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, type Session, type SessionMetadata } from '@littlesheep/types'
import type { AgentRunner, RunnerResult, RunInput } from '@littlesheep/runner'
import { DEFAULT_CONFIG, type Config, type ChannelConfig } from '@littlesheep/config'
import type { AgentTool, ToolRegistration } from '@littlesheep/types'
import { loadSkillIndex, type SkillIndex, type SkillSourceDefinition } from '@littlesheep/skills'
import {
  createPluginHost,
  type ChannelContext,
  type ChannelPlugin,
  type PluginManifest,
  type PluginSource,
} from './index.js'

class MockChannel implements ChannelPlugin {
  readonly type = 'mock'
  readonly displayName = 'Mock'
  readonly requiredSecrets: string[] = []
  running = false

  async start(_ctx: ChannelContext): Promise<void> {
    this.running = true
  }

  async stop(): Promise<void> {
    this.running = false
  }
}

function makeRegistry() {
  const registrations = new Map<string, ToolRegistration>()
  return {
    registrations,
    register(tool: AgentTool, source = 'builtin') {
      if (registrations.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`)
      registrations.set(tool.name, { tool, source })
    },
    unregister(name: string) { return registrations.delete(name) },
  }
}

function makeRunner(baseSkillSources: SkillSourceDefinition[] = []) {
  const sessions = new Map<string, Session>()
  const registry = makeRegistry()
  let skillIndex: SkillIndex = { skills: [], discovered: [], sources: baseSkillSources, disabled: [] }
  const skillLoader = {
    get index() { return skillIndex },
    async loadBody() { return undefined },
    async reload() {
      skillIndex = await loadSkillIndex({ sources: skillIndex.sources })
      return skillIndex
    },
    async replaceOwnedSources(kind: SkillSourceDefinition['kind'], sources: SkillSourceDefinition[]) {
      skillIndex = await loadSkillIndex({
        sources: [
          ...baseSkillSources.filter((source) => source.kind !== kind),
          ...sources,
        ],
      })
      return skillIndex
    },
  }
  const memoryService = {
    syncSkillResources: vi.fn(async () => undefined),
  }
  let counter = 0
  const sessionManager = {
    async create(model?: string, _title?: string, meta?: Partial<SessionMetadata>): Promise<Session> {
      const id = asSessionId(`s-${++counter}`)
      const now = new Date().toISOString()
      const session = { id, metadata: { createdAt: now, updatedAt: now, messageCount: 0, model, ...meta }, messages: [] }
      sessions.set(id, session)
      return session
    },
    async delete() {},
    async list() { return Array.from(sessions.keys()) },
    async listByChannel() { return [] },
  } as unknown as AgentRunner['sessionManager']

  const runner: AgentRunner = {
    async run(input: RunInput): Promise<RunnerResult> {
      return {
        runId: 'run-1', sessionId: input.sessionId ?? asSessionId('default'), status: 'ok',
        reply: input.text, messages: [], trace: [], durationMs: 0,
      }
    },
    async runStream(input: RunInput) { return this.run(input) },
    async replay() { return null },
    runtimeEvents: {
      append: () => ({ kind: 'rejected', reason: 'run-not-active', message: 'mock runner' }),
      summary: () => null,
    },
    async shutdown() {},
    state: { sessionId: undefined, model: 'mock' },
    sessionManager,
    infra: { registry, skillLoader, memoryService } as unknown as AgentRunner['infra'],
    model: 'mock',
  }
  return { runner, registry, skillLoader, memoryService }
}

const channelManifest: PluginManifest = {
  id: 'test.channel.mock',
  name: 'Mock channel',
  version: '1.0.0',
  apiVersion: 1,
  description: 'test',
  capabilities: ['channel'],
  permissions: ['agent:run', 'channels:register'],
  activationEvents: ['onChannel:mock'],
  contributes: { channels: ['mock'], tools: [], skills: [] },
}

const toolManifest: PluginManifest = {
  id: 'test.tool.echo',
  name: 'Echo tool',
  version: '1.0.0',
  apiVersion: 1,
  description: 'test',
  capabilities: ['tool'],
  permissions: ['tools:register'],
  activationEvents: ['onStartup'],
  contributes: { channels: [], tools: ['plugin_echo'], skills: [] },
}

const skillManifest: PluginManifest = {
  id: 'test.skill.planner',
  name: 'Planner skill',
  version: '1.0.0',
  apiVersion: 1,
  description: 'test',
  capabilities: ['skill'],
  permissions: ['skills:register'],
  activationEvents: ['onStartup'],
  contributes: { channels: [], tools: [], skills: ['planner'] },
}

const echoTool: AgentTool = {
  name: 'plugin_echo',
  description: 'Echo input',
  inputSchema: { parse: (input: unknown) => input },
  async execute(input) {
    return { callId: 'plugin-echo', ok: true, output: input }
  },
}

function makeSource(): PluginSource {
  let instances = 0
  return {
    kind: 'builtin',
    manifest: channelManifest,
    async load() {
      instances++
      return {
        manifest: channelManifest,
        activate(context) {
          context.registerChannelType('mock', () => new MockChannel())
        },
      }
    },
    get instances() { return instances },
  } as PluginSource & { instances: number }
}

function makeToolSource(kind: PluginSource['kind'] = 'builtin'): PluginSource & { instances: number } {
  let instances = 0
  return {
    kind,
    manifest: toolManifest,
    location: kind === 'local' ? join(tempDir, 'local-tool') : undefined,
    async load() {
      instances++
      return {
        manifest: toolManifest,
        activate(context) {
          context.registerTool(echoTool)
        },
      }
    },
    get instances() { return instances },
  }
}

function makeSkillSource(): PluginSource & { instances: number; location: string } {
  let instances = 0
  const location = join(tempDir, 'planner-plugin')
  const skillDir = join(location, 'skills', 'planner')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: planner\ndescription: Plan multi-step work.\n---\nPlan carefully.\n',
    'utf8',
  )
  return {
    kind: 'builtin',
    manifest: skillManifest,
    location,
    async load() {
      instances++
      return { manifest: skillManifest, activate() {} }
    },
    get instances() { return instances },
  }
}

function configFor(channels: ChannelConfig[], overrides: Partial<Config['plugins']> = {}): Config {
  return { ...DEFAULT_CONFIG, channels: { channels }, plugins: { ...DEFAULT_CONFIG.plugins, ...overrides } }
}

function channelConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: 'mock-1', type: 'mock', enabled: true, dmPolicy: { type: 'open' },
    groupPolicy: { type: 'disabled' }, model: undefined, secrets: {}, options: {}, ...overrides,
  }
}

let tempDir: string

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'ls-plugins-')) })
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }) })

describe('plugin host', () => {
  it('does not load a channel implementation when no channel is enabled', async () => {
    const source = makeSource() as PluginSource & { instances: number }
    const { runner } = makeRunner()
    const host = createPluginHost({
      runner, config: configFor([]), bindingsFile: join(tempDir, 'bindings.json'),
      pluginInstallDir: join(tempDir, 'plugins'), pluginDataDir: join(tempDir, 'plugin-data'),
      builtinSources: [source],
    })
    await host.start()
    expect(source.instances).toBe(0)
    expect(host.listPlugins()[0]?.state).toBe('inactive')
  })

  it('activates only the plugin required by an enabled channel', async () => {
    const source = makeSource() as PluginSource & { instances: number }
    const { runner } = makeRunner()
    const host = createPluginHost({
      runner, config: configFor([channelConfig()]), bindingsFile: join(tempDir, 'bindings.json'),
      pluginInstallDir: join(tempDir, 'plugins'), pluginDataDir: join(tempDir, 'plugin-data'),
      builtinSources: [source],
    })
    await host.start()
    expect(source.instances).toBe(1)
    expect(host.listChannels()).toHaveLength(1)
    expect(host.listPlugins()[0]?.state).toBe('active')
    await host.stop()
    expect(host.listChannels()).toHaveLength(0)
  })

  it('honors the disabled plugin list and reports a missing channel contribution', async () => {
    const source = makeSource() as PluginSource & { instances: number }
    const { runner } = makeRunner()
    const host = createPluginHost({
      runner, config: configFor([channelConfig()], { disabled: [channelManifest.id] }),
      bindingsFile: join(tempDir, 'bindings.json'), pluginInstallDir: join(tempDir, 'plugins'),
      pluginDataDir: join(tempDir, 'plugin-data'), builtinSources: [source],
    })
    await host.start()
    expect(source.instances).toBe(0)
    expect(host.listPlugins()[0]?.state).toBe('disabled')
    expect(host.channelFailures()[0]?.type).toBe('mock')
  })

  it('keeps the core host alive when a plugin activation fails', async () => {
    const source: PluginSource = {
      kind: 'builtin', manifest: { ...channelManifest, id: 'test.failed' },
      async load() { throw new Error('module unavailable') },
    }
    const { runner } = makeRunner()
    const host = createPluginHost({
      runner, config: configFor([channelConfig()]), bindingsFile: join(tempDir, 'bindings.json'),
      pluginInstallDir: join(tempDir, 'plugins'), pluginDataDir: join(tempDir, 'plugin-data'),
      builtinSources: [source],
    })
    await expect(host.start()).resolves.toBeUndefined()
    expect(host.listPlugins()[0]?.state).toBe('failed')
    expect(host.listPlugins()[0]?.error).toContain('module unavailable')
  })

  it('registers tool contributions and migrates them when the runner is rebuilt', async () => {
    const source = makeToolSource()
    const first = makeRunner()
    const host = createPluginHost({
      runner: first.runner, config: configFor([]), bindingsFile: join(tempDir, 'bindings.json'),
      pluginInstallDir: join(tempDir, 'plugins'), pluginDataDir: join(tempDir, 'plugin-data'),
      builtinSources: [source],
    })

    await host.start()
    expect(first.registry.registrations.get('plugin_echo')?.source).toBe(`plugin:${toolManifest.id}`)

    const second = makeRunner()
    await host.setRunner(second.runner)
    expect(first.registry.registrations.has('plugin_echo')).toBe(false)
    expect(second.registry.registrations.get('plugin_echo')?.source).toBe(`plugin:${toolManifest.id}`)

    await host.stop()
    expect(second.registry.registrations.has('plugin_echo')).toBe(false)
  })

  it('does not overwrite or later remove a rebuilt runner tool when migration collides', async () => {
    const source = makeToolSource()
    const first = makeRunner()
    const host = createPluginHost({
      runner: first.runner, config: configFor([]), bindingsFile: join(tempDir, 'bindings.json'),
      pluginInstallDir: join(tempDir, 'plugins'), pluginDataDir: join(tempDir, 'plugin-data'),
      builtinSources: [source],
    })
    await host.start()

    const second = makeRunner()
    second.registry.register(echoTool, 'builtin')
    await host.setRunner(second.runner)

    expect(host.listPlugins()[0]?.state).toBe('failed')
    expect(second.registry.registrations.get('plugin_echo')?.source).toBe('builtin')
    expect(first.registry.registrations.get('plugin_echo')?.source).toBe(`plugin:${toolManifest.id}`)

    await host.stop()
    expect(second.registry.registrations.get('plugin_echo')?.source).toBe('builtin')
    expect(first.registry.registrations.has('plugin_echo')).toBe(false)
  })

  it('blocks local code until the explicit trust gate is enabled', async () => {
    const source = makeToolSource('local')
    const { runner } = makeRunner()
    const host = createPluginHost({
      runner, config: configFor([]), bindingsFile: join(tempDir, 'bindings.json'),
      pluginInstallDir: join(tempDir, 'plugins'), pluginDataDir: join(tempDir, 'plugin-data'),
      builtinSources: [source],
    })

    await host.start()
    expect(source.instances).toBe(0)
    expect(host.listPlugins()[0]).toMatchObject({ state: 'blocked', source: 'local' })

    host.setConfig(configFor([], { allowLocalCode: true }))
    await host.reload()
    expect(source.instances).toBe(1)
    expect(host.listPlugins()[0]?.state).toBe('active')
  })

  it('keeps plugin skills attached to their owner across disable and runner rebuild', async () => {
    const source = makeSkillSource()
    const first = makeRunner()
    const host = createPluginHost({
      runner: first.runner, config: configFor([]), bindingsFile: join(tempDir, 'bindings.json'),
      pluginInstallDir: join(tempDir, 'plugins'), pluginDataDir: join(tempDir, 'plugin-data'),
      builtinSources: [source],
    })

    await host.start()
    expect(first.skillLoader.index.skills).toEqual([
      expect.objectContaining({ name: 'planner', source: expect.objectContaining({ ownerId: skillManifest.id }) }),
    ])
    expect(first.memoryService.syncSkillResources).toHaveBeenLastCalledWith(
      [expect.objectContaining({ name: 'planner', availability: 'active' })],
      [expect.objectContaining({ id: `plugin:${skillManifest.id}`, enabled: true })],
      { ownerKinds: ['plugin'] },
    )

    host.setConfig(configFor([], { disabled: [skillManifest.id] }))
    await host.reload()
    expect(first.skillLoader.index.skills).toHaveLength(0)
    expect(first.skillLoader.index.discovered).toEqual([
      expect.objectContaining({ name: 'planner', availability: 'disabled' }),
    ])

    host.setConfig(configFor([]))
    await host.reload()
    const second = makeRunner()
    await host.setRunner(second.runner)
    expect(second.skillLoader.index.skills).toEqual([
      expect.objectContaining({ name: 'planner', availability: 'active' }),
    ])
  })

  it('fails a plugin whose skill name is shadowed by an existing owner', async () => {
    const source = makeSkillSource()
    const baseDir = join(tempDir, 'base-skills')
    const baseSkillDir = join(baseDir, 'planner')
    mkdirSync(baseSkillDir, { recursive: true })
    writeFileSync(
      join(baseSkillDir, 'SKILL.md'),
      '---\nname: planner\ndescription: Built-in planner.\n---\nBase plan.\n',
      'utf8',
    )
    const runner = makeRunner([{ id: 'builtin', kind: 'builtin', dir: baseDir }])
    const host = createPluginHost({
      runner: runner.runner, config: configFor([]), bindingsFile: join(tempDir, 'bindings.json'),
      pluginInstallDir: join(tempDir, 'plugins'), pluginDataDir: join(tempDir, 'plugin-data'),
      builtinSources: [source],
    })

    await host.start()

    expect(host.listPlugins()[0]).toMatchObject({ state: 'failed' })
    expect(host.listPlugins()[0]?.error).toContain('conflicts with another active skill')
    expect(runner.skillLoader.index.skills).toEqual([
      expect.objectContaining({ name: 'planner', description: 'Built-in planner.' }),
    ])
    expect(runner.skillLoader.index.discovered).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: expect.objectContaining({ kind: 'plugin' }), availability: 'disabled' }),
    ]))
  })

  it('removes a local plugin Skill from the runtime and marks its owner absent on reload', async () => {
    const installDir = join(tempDir, 'plugins')
    const pluginDir = join(installDir, 'local-planner')
    const skillDir = join(pluginDir, 'skills', 'planner')
    mkdirSync(skillDir, { recursive: true })
    const manifest = { ...skillManifest, id: 'test.local.planner', main: './index.mjs' }
    writeFileSync(join(pluginDir, 'littlesheep.plugin.json'), JSON.stringify(manifest), 'utf8')
    writeFileSync(
      join(pluginDir, 'index.mjs'),
      `const manifest = ${JSON.stringify({ ...manifest, main: undefined })};\nexport default { manifest, activate() {} };\n`,
      'utf8',
    )
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: planner\ndescription: Local planner.\n---\nPlan locally.\n',
      'utf8',
    )
    const runner = makeRunner()
    const host = createPluginHost({
      runner: runner.runner,
      config: configFor([], { allowLocalCode: true }),
      bindingsFile: join(tempDir, 'bindings.json'),
      pluginInstallDir: installDir,
      pluginDataDir: join(tempDir, 'plugin-data'),
    })

    await host.start()
    expect(runner.skillLoader.index.skills).toEqual([
      expect.objectContaining({ name: 'planner', source: expect.objectContaining({ ownerId: 'test.local.planner' }) }),
    ])

    rmSync(pluginDir, { recursive: true, force: true })
    await host.reload()

    expect(host.listPlugins()).toEqual([])
    expect(runner.skillLoader.index.discovered).toEqual([])
    expect(runner.memoryService.syncSkillResources).toHaveBeenLastCalledWith(
      [],
      [],
      { ownerKinds: ['plugin'] },
    )
  })
})
