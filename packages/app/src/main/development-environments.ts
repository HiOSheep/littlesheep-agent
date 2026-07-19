// LS-owned development environment registry, detection and terminal PATH setup.

import { chmod, cp, lstat, mkdir, rename, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, delimiter, join, resolve } from 'node:path'
import { atomicWrite } from '@littlesheep/memory-core'
import {
  DEVELOPMENT_ENVIRONMENT_IDS,
  type DevelopmentEnvironmentId,
  type DevelopmentEnvironmentInfo,
  type DevelopmentEnvironmentPreferences,
  type DevelopmentEnvironmentSnapshot,
} from '../shared/development-environment-contracts.js'

const SNAPSHOT_CACHE_MS = 4_000
import { DEFINITION_BY_ID, ENVIRONMENT_DEFINITIONS, type EnvironmentDefinition } from './development-environment-definitions.js'
import {
  assertNoSymlinks,
  canonicalVersionLabel,
  findFirstFile,
  findImportExecutable,
  findSystemExecutable,
  isDirectChild,
  isPathWithin,
  listManagedVersions,
  managedPathEntries,
  normalizeRequestedVersion,
  pathExists,
  readPreferences,
  readVersion,
  shellQuote,
  STAGING_DIRECTORY,
  uniquePaths,
  versionMatchesPreference,
  writeIfChanged,
} from './development-environment-files.js'

export interface DevelopmentEnvironmentManagerOptions {
  dataDir: string
  electronExecutable?: string
  platform?: NodeJS.Platform
  baseEnvironment?: NodeJS.ProcessEnv
}

export class DevelopmentEnvironmentManager {
  readonly toolchainsRoot: string
  readonly preferencesPath: string
  private readonly electronExecutable: string
  private readonly platform: NodeJS.Platform
  private readonly baseEnvironment: NodeJS.ProcessEnv
  private preferences: DevelopmentEnvironmentPreferences = { versions: {} }
  private initialized = false
  private initializePromise: Promise<void> | null = null
  private snapshotCache: { expiresAt: number; value: DevelopmentEnvironmentSnapshot } | null = null
  private snapshotPromise: Promise<DevelopmentEnvironmentSnapshot> | null = null
  private mutationPromise: Promise<void> = Promise.resolve()

  constructor(options: DevelopmentEnvironmentManagerOptions) {
    this.toolchainsRoot = resolve(options.dataDir, 'toolchains')
    this.preferencesPath = join(this.toolchainsRoot, 'preferences.json')
    this.electronExecutable = options.electronExecutable ?? process.execPath
    this.platform = options.platform ?? process.platform
    this.baseEnvironment = { ...(options.baseEnvironment ?? process.env) }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        await mkdir(this.toolchainsRoot, { recursive: true })
        this.preferences = await readPreferences(this.preferencesPath)
        await this.ensureNodeShim()
        this.initialized = true
      })().finally(() => {
        this.initializePromise = null
      })
    }
    await this.initializePromise
  }

  async snapshot(force = false): Promise<DevelopmentEnvironmentSnapshot> {
    await this.initialize()
    const now = Date.now()
    if (!force && this.snapshotCache && this.snapshotCache.expiresAt > now) return this.snapshotCache.value
    if (this.snapshotPromise) return this.snapshotPromise
    this.snapshotPromise = this.detectSnapshot()
      .then((value) => {
        this.snapshotCache = { expiresAt: Date.now() + SNAPSHOT_CACHE_MS, value }
        return value
      })
      .finally(() => {
        this.snapshotPromise = null
      })
    return this.snapshotPromise
  }

  async setVersion(environmentId: DevelopmentEnvironmentId, version: string | null): Promise<DevelopmentEnvironmentSnapshot> {
    await this.initialize()
    if (!DEFINITION_BY_ID.has(environmentId)) throw new Error(`unknown development environment: ${environmentId}`)
    const normalized = normalizeRequestedVersion(version)
    if (version !== null && version !== undefined && !normalized) {
      throw new Error('invalid development environment version')
    }
    await this.enqueueMutation(async () => {
      const versions = { ...this.preferences.versions }
      if (normalized) versions[environmentId] = normalized
      else delete versions[environmentId]
      await this.savePreferences({ versions })
    })
    return this.snapshot(true)
  }

  /**
   * Import an already downloaded and extracted runtime into the portable LS
   * toolchain directory. The source is never moved or modified.
   */
  async importVersion(
    environmentId: DevelopmentEnvironmentId,
    version: string | null,
    sourceDirectory: string,
  ): Promise<DevelopmentEnvironmentSnapshot> {
    await this.initialize()
    const definition = DEFINITION_BY_ID.get(environmentId)
    if (!definition) throw new Error(`unknown development environment: ${environmentId}`)
    const normalizedVersion = normalizeRequestedVersion(version)
    if (version !== null && version !== undefined && !normalizedVersion) {
      throw new Error('invalid development environment version')
    }

    await this.enqueueMutation(async () => {
      const source = resolve(sourceDirectory)
      if (isPathWithin(this.toolchainsRoot, source)) {
        throw new Error('toolchain source must be outside the LS toolchain directory')
      }
      const sourceInfo = await stat(source)
      if (!sourceInfo.isDirectory()) throw new Error('toolchain source must be a directory')

      const discovered = await findImportExecutable(definition, source)
      if (!discovered) throw new Error(`没有在所选目录中找到可用的 ${definition.label} 可执行文件`)
      await assertNoSymlinks(discovered.root)
      const detectedVersion = await readVersion(
        discovered.path,
        definition.versionArgs,
        this.baseEnvironmentFor(definition),
      )
      const actualVersion = canonicalVersionLabel(detectedVersion)
      if (!actualVersion) throw new Error('无法从工具链读取版本，请手动填写版本号')
      if (normalizedVersion && !versionMatchesPreference(actualVersion, normalizedVersion)) {
        throw new Error(`所选目录实际版本为 ${actualVersion}，与目标版本 ${normalizedVersion} 不一致`)
      }
      // Store the concrete detected version so two patch releases can coexist;
      // the preference may remain a series such as 3.12 and select the newest
      // matching imported release at runtime.
      const storageVersion = actualVersion
      const preferenceVersion = normalizedVersion ?? storageVersion

      const environmentRoot = join(this.toolchainsRoot, environmentId)
      const destination = join(environmentRoot, storageVersion)
      if (!isDirectChild(environmentRoot, destination)) throw new Error('invalid toolchain destination')
      if (await pathExists(destination)) throw new Error(`LS 已存在 ${definition.label} ${storageVersion}`)

      const stagingRoot = join(
        this.toolchainsRoot,
        STAGING_DIRECTORY,
        `${environmentId}-${storageVersion}-${randomUUID()}`,
      )
      await mkdir(dirname(destination), { recursive: true })
      await mkdir(dirname(stagingRoot), { recursive: true })
      try {
        await cp(discovered.root, stagingRoot, {
          recursive: true,
          force: false,
          errorOnExist: true,
          verbatimSymlinks: true,
        })
        await assertNoSymlinks(stagingRoot)
        const stagedExecutable = await findFirstFile(stagingRoot, definition.managedCandidates)
        if (!stagedExecutable) throw new Error('工具链复制后未找到可执行文件，导入已取消')
        const stagedVersion = await readVersion(
          stagedExecutable,
          definition.versionArgs,
          this.baseEnvironmentFor(definition),
        )
        if (!stagedVersion || !versionMatchesPreference(stagedVersion, normalizedVersion ?? storageVersion)) {
          throw new Error('工具链复制后版本校验失败，导入已取消')
        }
        await rename(stagingRoot, destination)
        try {
          await this.savePreferences({
            versions: { ...this.preferences.versions, [environmentId]: preferenceVersion },
          })
        } catch (error) {
          await rm(destination, { recursive: true, force: true }).catch(() => undefined)
          throw error
        }
      } finally {
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
      }
      this.snapshotCache = null
    })
    return this.snapshot(true)
  }

  async removeVersion(
    environmentId: DevelopmentEnvironmentId,
    version: string,
  ): Promise<DevelopmentEnvironmentSnapshot> {
    await this.initialize()
    if (!DEFINITION_BY_ID.has(environmentId)) throw new Error(`unknown development environment: ${environmentId}`)
    const normalized = normalizeRequestedVersion(version)
    if (!normalized) throw new Error('invalid development environment version')
    await this.enqueueMutation(async () => {
      const environmentRoot = join(this.toolchainsRoot, environmentId)
      const target = join(environmentRoot, normalized)
      if (!isDirectChild(environmentRoot, target)) throw new Error('invalid toolchain destination')
      const info = await lstat(target).catch(() => null)
      if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`LS 未找到 ${environmentId} ${normalized}`)
      await rm(target, { recursive: true, force: false })
      const remainingVersions = await listManagedVersions(environmentRoot, DEFINITION_BY_ID.get(environmentId)!)
      const requestedVersion = this.preferences.versions[environmentId]
      if (requestedVersion
        && versionMatchesPreference(normalized, requestedVersion)
        && !remainingVersions.some((item) => versionMatchesPreference(item, requestedVersion))) {
        const versions = { ...this.preferences.versions }
        delete versions[environmentId]
        await this.savePreferences({ versions })
      }
      this.snapshotCache = null
    })
    return this.snapshot(true)
  }

  async terminalEnvironment(): Promise<NodeJS.ProcessEnv> {
    const snapshot = await this.snapshot()
    const pathEntries: string[] = []
    for (const environment of snapshot.environments) {
      if (environment.source === 'managed' || environment.source === 'builtin') {
        pathEntries.push(...environment.terminalPathEntries)
      }
    }
    const systemPathEntries = snapshot.environments
      .filter((environment) => environment.source === 'system')
      .flatMap((environment) => environment.terminalPathEntries)
    const uniqueEntries = uniquePaths([...pathEntries, ...systemPathEntries], this.platform)
    const env: NodeJS.ProcessEnv = { ...this.baseEnvironment }
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
    const currentPath = env[pathKey] ?? ''
    env[pathKey] = [...uniqueEntries, currentPath].filter(Boolean).join(delimiter)
    env.LITTLESHEEP_TOOLCHAINS_ROOT = this.toolchainsRoot
    return env
  }

  private async detectSnapshot(): Promise<DevelopmentEnvironmentSnapshot> {
    const environments = await Promise.all(ENVIRONMENT_DEFINITIONS.map((definition) => this.detectEnvironment(definition)))
    return {
      toolchainsRoot: this.toolchainsRoot,
      preferencesPath: this.preferencesPath,
      environments,
      generatedAt: new Date().toISOString(),
    }
  }

  private async detectEnvironment(definition: EnvironmentDefinition): Promise<DevelopmentEnvironmentInfo> {
    const requestedVersion = this.preferences.versions[definition.id] ?? null
    const availableVersions = await listManagedVersions(join(this.toolchainsRoot, definition.id), definition)
    const managed = await this.findManagedExecutable(definition, requestedVersion, availableVersions)
    if (managed) {
      const currentVersion = await readVersion(
        managed.path,
        definition.versionArgs,
        this.baseEnvironmentFor(definition),
      )
        const versionMatches = !!currentVersion && (!requestedVersion || versionMatchesPreference(currentVersion, requestedVersion))
      return this.info(definition, {
        source: 'managed',
        state: versionMatches && currentVersion ? 'ready' : 'version-pending',
        currentVersion,
        activeManagedVersion: managed.version,
        requestedVersion,
        executablePath: managed.path,
        terminalPathEntries: versionMatches ? managed.pathEntries : [],
        note: versionMatches && currentVersion
          ? '由 LS 数据根管理，终端会优先使用该版本。'
          : `已找到 LS 管理版本，但与目标版本 ${requestedVersion} 不一致。`,
        availableVersions,
      })
    }
    if (definition.builtin && definition.id === 'node') {
      const executablePath = this.electronExecutable
      const currentVersion = await readVersion(
        executablePath,
        ['-e', 'process.stdout.write(process.version)'],
        this.baseEnvironmentFor(definition),
      )
      const versionMatches = !requestedVersion
        || (!!currentVersion && versionMatchesPreference(currentVersion, requestedVersion))
      return this.info(definition, {
        source: 'builtin',
        state: versionMatches && currentVersion ? 'ready' : requestedVersion ? 'version-pending' : 'missing',
        currentVersion,
        activeManagedVersion: null,
        requestedVersion,
        executablePath,
        terminalPathEntries: versionMatches && currentVersion ? [join(this.toolchainsRoot, 'node', 'bin')] : [],
        note: !currentVersion
          ? '无法验证 Electron 内置 Node。'
          : versionMatches
            ? 'LS 使用当前 Electron 内置 Node；Node 本体随应用发布，不从系统 PATH 取用。'
          : `当前 Electron 内置 Node 为 ${currentVersion}，与目标版本 ${requestedVersion} 不一致；目标版本准备好后才会切换。`,
        availableVersions,
      })
    }
    const system = await findSystemExecutable(definition, this.platform, this.baseEnvironment)
    if (system) {
      const currentVersion = await readVersion(system, definition.versionArgs, this.baseEnvironment)
      return this.info(definition, {
        source: 'system',
        state: requestedVersion ? 'version-pending' : 'system-fallback',
        currentVersion,
        activeManagedVersion: null,
        requestedVersion,
        executablePath: system,
        terminalPathEntries: [dirname(system)],
        note: requestedVersion
          ? `系统中可用，但尚未准备 LS 管理的目标版本 ${requestedVersion}。`
          : '当前使用系统版本；可在准备 LS 运行时后切换为受管版本。',
        availableVersions,
      })
    }
    return this.info(definition, {
      source: 'missing',
      state: requestedVersion ? 'version-pending' : 'missing',
      currentVersion: null,
      activeManagedVersion: null,
      requestedVersion,
      executablePath: null,
      terminalPathEntries: [],
      note: requestedVersion
        ? `已记录目标版本 ${requestedVersion}，但该版本尚未放入 LS 工具链目录。`
        : '未发现可用版本；设置目标版本后可由后续工具链准备流程安装。',
      availableVersions,
    })
  }

  private info(
    definition: EnvironmentDefinition,
    values: Pick<DevelopmentEnvironmentInfo, 'source' | 'state' | 'currentVersion' | 'activeManagedVersion' | 'requestedVersion' | 'executablePath' | 'terminalPathEntries' | 'note'> & Partial<Pick<DevelopmentEnvironmentInfo, 'availableVersions'>>,
  ): DevelopmentEnvironmentInfo {
    return {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      category: definition.category,
      managedRoot: join(this.toolchainsRoot, definition.id),
      availableVersions: values.availableVersions ?? [],
      ...values,
    }
  }

  private async findManagedExecutable(
    definition: EnvironmentDefinition,
    requestedVersion: string | null,
    availableVersions: string[],
  ): Promise<{ path: string; pathEntries: string[]; version: string } | null> {
    const root = join(this.toolchainsRoot, definition.id)
    // Electron's Node shim lives in <toolchains>/node/bin and is not a
    // versioned runtime. A custom Node version is used only when explicitly
    // selected; otherwise the bundled Electron Node remains the default.
    const orderedVersions = requestedVersion
      ? availableVersions.filter((version) => versionMatchesPreference(version, requestedVersion))
      : definition.builtin ? [] : availableVersions
    for (const version of orderedVersions) {
      const versionRoot = join(root, version)
      const executable = await findFirstFile(versionRoot, definition.managedCandidates)
      if (!executable) continue
      return {
        path: executable,
        pathEntries: managedPathEntries(versionRoot, executable, this.platform),
        version,
      }
    }
    return null
  }

  private async ensureNodeShim(): Promise<void> {
    const binDir = join(this.toolchainsRoot, 'node', 'bin')
    await mkdir(binDir, { recursive: true })
    if (this.platform === 'win32') {
      const target = join(binDir, 'node.cmd')
      const content = `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${this.electronExecutable}" %*\r\n`
      await writeIfChanged(target, content)
      return
    }
    const target = join(binDir, 'node')
    const content = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(this.electronExecutable)} "$@"\n`
    await writeIfChanged(target, content)
    await chmod(target, 0o755)
  }

  private baseEnvironmentFor(definition: EnvironmentDefinition): NodeJS.ProcessEnv {
    return definition.id === 'node'
      ? { ...this.baseEnvironment, ELECTRON_RUN_AS_NODE: '1' }
      : this.baseEnvironment
  }

  private async savePreferences(next: DevelopmentEnvironmentPreferences): Promise<void> {
    await atomicWrite(this.preferencesPath, `${JSON.stringify(next, null, 2)}\n`)
    this.preferences = next
    this.snapshotCache = null
  }

  private async enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationPromise.catch(() => undefined).then(operation)
    this.mutationPromise = result.then(() => undefined, () => undefined)
    return result
  }
}

export function developmentEnvironmentDefinitionIds(): DevelopmentEnvironmentId[] {
  return [...DEVELOPMENT_ENVIRONMENT_IDS]
}
