// Plans and executes restart-time data-root migration with manifests, staging,
// internal path rebinding, atomic commit and recoverable rollback.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import {
  dataRootLocatorPath,
  parseDataRootLocator,
  resolveDefaultDataDir,
  type BrandingConfig,
  type CompletedDataRootMigration,
  type DataRootLocatorDocument,
  type PendingDataRootMigration,
  type PendingDataRootRollback,
} from '@littlesheep/branding'
import { atomicWrite } from '@littlesheep/memory-core'
import type { DataRootStatus } from '../shared/runtime-api-contracts.js'
import { isPathInsideOrSameBound, sameBoundPath } from './path-rebinding.js'
import { rebindDataRootMetadata, type DataRootMetadataRebindReport } from './data-root-metadata.js'

export type DataRootMigrationFaultPoint =
  | 'after-copy'
  | 'after-metadata-rebind'
  | 'after-verify'
  | 'after-target-commit'
  | 'after-locator-commit'

export interface DataRootMigrationFaultContext {
  sourceDir: string
  targetDir: string
  stageDir: string
}

export interface DataRootMigrationManagerOptions {
  branding: BrandingConfig
  faultInjector?: (
    point: DataRootMigrationFaultPoint,
    context: DataRootMigrationFaultContext,
  ) => void | Promise<void>
}

export type { DataRootStatus } from '../shared/runtime-api-contracts.js'

interface TreeFile {
  relativePath: string
  absolutePath: string
  size: number
  mode: number
  atime: Date
  mtime: Date
  hash: string
}

interface TreeSnapshot {
  directories: string[]
  files: TreeFile[]
  fileCount: number
  totalBytes: number
  manifestHash: string
}

export interface DataRootMigrationResult {
  status: DataRootStatus
  metadata?: DataRootMetadataRebindReport
}

export class DataRootMigrationManager {
  private operationTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: DataRootMigrationManagerOptions) {}

  async status(): Promise<DataRootStatus> {
    const environmentOverride = process.env.LITTLESHEEP_DATA_DIR
      ? resolve(process.env.LITTLESHEEP_DATA_DIR)
      : undefined
    const locator = await this.readLocator()
    const currentDataDir = environmentOverride ?? locator.activeDataDir
    const pendingMigration = environmentOverride ? undefined : locator.pendingMigration
    const pendingRollback = environmentOverride ? undefined : locator.pendingRollback
    return {
      managed: !environmentOverride,
      currentDataDir,
      defaultDataDir: resolveDefaultDataDir(this.options.branding),
      locatorPath: dataRootLocatorPath(this.options.branding),
      environmentOverride,
      previousDataDir: locator.previousDataDir,
      pendingMigration,
      pendingRollback,
      lastMigration: locator.lastMigration,
      requiresRestart: !!pendingMigration || !!pendingRollback,
      canRollback: !environmentOverride && !!locator.previousDataDir && await isRegularDirectory(locator.previousDataDir),
    }
  }

  async requestMigration(targetDir: string): Promise<DataRootStatus> {
    return this.serialize(async () => {
      this.assertManaged()
      const locator = await this.readLocator()
      if (locator.pendingMigration || locator.pendingRollback) {
        throw new Error('已有待处理的数据目录操作，请先取消或重启应用完成它')
      }
      const sourceDir = resolve(locator.activeDataDir)
      const target = resolveRequiredDirectoryPath(targetDir)
      assertSeparateDataRoots(sourceDir, target)
      await assertDirectoryMissingOrEmpty(target)
      const id = randomUUID()
      const now = new Date().toISOString()
      const pendingMigration: PendingDataRootMigration = {
        id,
        sourceDir,
        targetDir: target,
        stageDir: migrationStagePath(target, id),
        phase: 'requested',
        createdAt: now,
        updatedAt: now,
        attempts: 0,
      }
      await this.writeLocator({
        ...locator,
        activeDataDir: sourceDir,
        pendingMigration,
        pendingRollback: undefined,
      })
      return this.status()
    })
  }

  async cancelPending(): Promise<DataRootStatus> {
    return this.serialize(async () => {
      this.assertManaged()
      const locator = await this.readLocator()
      const pending = locator.pendingMigration
      if (pending?.phase === 'committing'
        && await isRegularDirectory(pending.targetDir)
        && !await pathExists(pending.stageDir)) {
        throw new Error('迁移已经进入提交阶段，请重启应用完成恢复，不能直接取消')
      }
      if (pending) await removeOwnedStageDirectory(pending)
      await this.writeLocator({
        ...locator,
        pendingMigration: undefined,
        pendingRollback: undefined,
      })
      return this.status()
    })
  }

  async requestRollback(): Promise<DataRootStatus> {
    return this.serialize(async () => {
      this.assertManaged()
      const locator = await this.readLocator()
      if (locator.pendingMigration || locator.pendingRollback) {
        throw new Error('已有待处理的数据目录操作，请先取消或重启应用完成它')
      }
      if (!locator.previousDataDir || !await isRegularDirectory(locator.previousDataDir)) {
        throw new Error('没有可用的前一个数据目录')
      }
      const pendingRollback: PendingDataRootRollback = {
        id: randomUUID(),
        fromDir: resolve(locator.activeDataDir),
        toDir: resolve(locator.previousDataDir),
        createdAt: new Date().toISOString(),
      }
      await this.writeLocator({ ...locator, pendingRollback })
      return this.status()
    })
  }

  async prepareForBootstrap(): Promise<DataRootMigrationResult> {
    return this.serialize(async () => {
      if (process.env.LITTLESHEEP_DATA_DIR) return { status: await this.status() }
      let locator = await this.readLocator()
      if (locator.pendingRollback) {
        locator = await this.commitRollback(locator)
      }
      if (!locator.pendingMigration) return { status: await this.status() }
      try {
        const result = await this.executeMigration(locator, locator.pendingMigration)
        return { status: await this.status(), metadata: result.metadata }
      } catch (error) {
        await this.recordMigrationFailure(locator.pendingMigration.id, error)
        return { status: await this.status() }
      }
    })
  }

  private async executeMigration(
    locator: DataRootLocatorDocument,
    initial: PendingDataRootMigration,
  ): Promise<{ metadata?: DataRootMetadataRebindReport }> {
    const pending = {
      ...initial,
      attempts: initial.attempts + 1,
      updatedAt: new Date().toISOString(),
      error: undefined,
    }
    assertPendingStageOwnership(pending)
    assertSeparateDataRoots(pending.sourceDir, pending.targetDir)
    await assertRegularDirectory(pending.sourceDir, '源数据目录不存在或不是普通目录')

    if (pending.manifestHash && await isRegularDirectory(pending.targetDir) && !await pathExists(pending.stageDir)) {
      const committed = await buildTreeSnapshot(pending.targetDir)
      assertExpectedManifest(committed, pending)
      await this.commitLocator(locator, pending, committed)
      return {}
    }

    await assertDirectoryMissingOrEmpty(pending.targetDir)
    pending.phase = 'copying'
    await this.persistPending(locator, pending)
    const rawSnapshot = await mirrorTree(pending.sourceDir, pending.stageDir)
    await this.options.faultInjector?.('after-copy', migrationContext(pending))
    await verifyRawCopy(pending.sourceDir, pending.stageDir, rawSnapshot)

    const metadata = await rebindDataRootMetadata(
      pending.stageDir,
      pending.sourceDir,
      pending.targetDir,
    )
    await this.options.faultInjector?.('after-metadata-rebind', migrationContext(pending))

    pending.phase = 'verifying'
    await this.persistPending(locator, pending)
    const finalSnapshot = await buildTreeSnapshot(pending.stageDir)
    const secondPass = await buildTreeSnapshot(pending.stageDir)
    if (finalSnapshot.manifestHash !== secondPass.manifestHash
      || finalSnapshot.fileCount !== secondPass.fileCount
      || finalSnapshot.totalBytes !== secondPass.totalBytes) {
      throw new Error('迁移目标在校验期间发生变化')
    }
    pending.phase = 'committing'
    pending.fileCount = finalSnapshot.fileCount
    pending.totalBytes = finalSnapshot.totalBytes
    pending.manifestHash = finalSnapshot.manifestHash
    await this.persistPending(locator, pending)
    await this.options.faultInjector?.('after-verify', migrationContext(pending))

    if (await pathExists(pending.targetDir)) await rm(pending.targetDir, { recursive: true, force: false })
    await rename(pending.stageDir, pending.targetDir)
    await this.options.faultInjector?.('after-target-commit', migrationContext(pending))
    const committed = await buildTreeSnapshot(pending.targetDir)
    assertExpectedManifest(committed, pending)
    await this.commitLocator(locator, pending, committed)
    await this.options.faultInjector?.('after-locator-commit', migrationContext(pending))
    return { metadata }
  }

  private async commitLocator(
    locator: DataRootLocatorDocument,
    pending: PendingDataRootMigration,
    snapshot: TreeSnapshot,
  ): Promise<void> {
    const completedAt = new Date().toISOString()
    const lastMigration: CompletedDataRootMigration = {
      id: pending.id,
      sourceDir: pending.sourceDir,
      targetDir: pending.targetDir,
      completedAt,
      fileCount: snapshot.fileCount,
      totalBytes: snapshot.totalBytes,
      manifestHash: snapshot.manifestHash,
    }
    await this.writeLocator({
      ...locator,
      activeDataDir: pending.targetDir,
      previousDataDir: pending.sourceDir,
      pendingMigration: undefined,
      pendingRollback: undefined,
      lastMigration,
    })
  }

  private async commitRollback(locator: DataRootLocatorDocument): Promise<DataRootLocatorDocument> {
    const pending = locator.pendingRollback!
    try {
      if (!sameBoundPath(locator.activeDataDir, pending.fromDir)) {
        throw new Error('当前数据目录已变化，不能执行登记的回滚')
      }
      await assertRegularDirectory(pending.toDir, '前一个数据目录不存在或不是普通目录')
      const next: DataRootLocatorDocument = {
        ...locator,
        activeDataDir: pending.toDir,
        previousDataDir: pending.fromDir,
        pendingRollback: undefined,
      }
      await this.writeLocator(next)
      return next
    } catch (error) {
      const failed = {
        ...pending,
        error: errorMessage(error),
      }
      const next = { ...locator, pendingRollback: failed }
      await this.writeLocator(next)
      return next
    }
  }

  private async persistPending(
    locator: DataRootLocatorDocument,
    pending: PendingDataRootMigration,
  ): Promise<void> {
    pending.updatedAt = new Date().toISOString()
    await this.writeLocator({ ...locator, pendingMigration: { ...pending } })
  }

  private async recordMigrationFailure(id: string, error: unknown): Promise<void> {
    const locator = await this.readLocator()
    if (locator.pendingMigration?.id !== id) return
    const pending = locator.pendingMigration
    const committedTargetExists = pending.phase === 'committing'
      && await isRegularDirectory(pending.targetDir)
      && !await pathExists(pending.stageDir)
    await this.writeLocator({
      ...locator,
      pendingMigration: {
        ...pending,
        phase: committedTargetExists ? 'committing' : 'failed',
        updatedAt: new Date().toISOString(),
        error: errorMessage(error),
      },
    })
  }

  private async readLocator(): Promise<DataRootLocatorDocument> {
    const path = dataRootLocatorPath(this.options.branding)
    try {
      const parsed = parseDataRootLocator(JSON.parse(await readFile(path, 'utf8')) as unknown)
      if (parsed) return parsed
    } catch {
      // Missing or invalid locators fall back to the branding-defined data root.
    }
    return {
      version: 1,
      activeDataDir: resolveDefaultDataDir(this.options.branding),
    }
  }

  private async writeLocator(locator: DataRootLocatorDocument): Promise<void> {
    const parsed = parseDataRootLocator(locator)
    if (!parsed) throw new Error('拒绝写入无效的数据目录定位文件')
    const path = dataRootLocatorPath(this.options.branding)
    await mkdir(dirname(path), { recursive: true })
    await atomicWrite(path, JSON.stringify(parsed, null, 2))
  }

  private assertManaged(): void {
    if (process.env.LITTLESHEEP_DATA_DIR) {
      throw new Error('当前数据目录由 LITTLESHEEP_DATA_DIR 环境变量管理，应用内迁移已禁用')
    }
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail.catch(() => undefined)
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    this.operationTail = previous.then(() => gate)
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function resolveRequiredDirectoryPath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('请选择目标数据目录')
  const target = resolve(trimmed)
  if (target === dirname(target)) throw new Error('不能把磁盘根目录直接作为 LS 数据目录')
  return target
}

function assertSeparateDataRoots(sourceDir: string, targetDir: string): void {
  if (sameBoundPath(sourceDir, targetDir)) throw new Error('目标数据目录不能与当前目录相同')
  if (isPathInsideOrSameBound(sourceDir, targetDir) || isPathInsideOrSameBound(targetDir, sourceDir)) {
    throw new Error('源数据目录与目标目录不能互相包含')
  }
}

function migrationStagePath(targetDir: string, id: string): string {
  return join(dirname(targetDir), `.${basename(targetDir)}.littlesheep-migration-${id}`)
}

function assertPendingStageOwnership(pending: PendingDataRootMigration): void {
  const expected = migrationStagePath(pending.targetDir, pending.id)
  if (!sameBoundPath(expected, pending.stageDir)) {
    throw new Error('迁移 staging 目录不符合所有权约束')
  }
}

async function assertDirectoryMissingOrEmpty(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('目标数据目录必须不存在或是空的普通目录')
    }
    if ((await readdir(path)).length > 0) {
      throw new Error('目标数据目录不是空目录')
    }
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
}

async function assertRegularDirectory(path: string, message: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(message)
  } catch (error) {
    if (error instanceof Error && error.message === message) throw error
    throw new Error(message)
  }
}

async function isRegularDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function removeOwnedStageDirectory(pending: PendingDataRootMigration): Promise<void> {
  assertPendingStageOwnership(pending)
  if (!await pathExists(pending.stageDir)) return
  const info = await lstat(pending.stageDir)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('拒绝清理不符合约束的迁移 staging 路径')
  }
  await rm(pending.stageDir, { recursive: true, force: false })
}

async function mirrorTree(sourceRoot: string, stageRoot: string): Promise<TreeSnapshot> {
  const source = await buildTreeSnapshot(sourceRoot, { ignoreLinks: true })
  await mkdir(stageRoot, { recursive: true })
  await assertRegularDirectory(stageRoot, '迁移 staging 路径不是普通目录')

  for (const directory of source.directories) {
    await mkdir(join(stageRoot, directory), { recursive: true })
  }
  for (const file of source.files) {
    const target = join(stageRoot, file.relativePath)
    await mkdir(dirname(target), { recursive: true })
    if (!await fileMatches(target, file.size, file.hash)) {
      await rm(target, { recursive: true, force: true })
      await copyFile(file.absolutePath, target)
      await chmod(target, file.mode).catch(() => undefined)
      await utimes(target, file.atime, file.mtime).catch(() => undefined)
    }
    if (!await fileMatches(target, file.size, file.hash)) {
      throw new Error(`迁移复制校验失败: ${file.relativePath}`)
    }
  }
  await removeStaleStageEntries(stageRoot, source)
  return source
}

async function removeStaleStageEntries(stageRoot: string, source: TreeSnapshot): Promise<void> {
  const expectedFiles = new Set(source.files.map((file) => normalizeRelative(file.relativePath)))
  const expectedDirectories = new Set(source.directories.map(normalizeRelative))
  const stageEntries = await scanTreeEntries(stageRoot)
  for (const link of stageEntries.links) {
    await rm(link.absolutePath, { force: true })
  }
  for (const file of stageEntries.files) {
    if (!expectedFiles.has(normalizeRelative(file.relativePath))) {
      await rm(file.absolutePath, { force: true })
    }
  }
  const staleDirectories = stageEntries.directories
    .filter((entry) => !expectedDirectories.has(normalizeRelative(entry)))
    .sort((left, right) => right.split(/[\\/]/u).length - left.split(/[\\/]/u).length)
  for (const directory of staleDirectories) {
    await rm(join(stageRoot, directory), { recursive: true, force: true })
  }
}

async function verifyRawCopy(sourceRoot: string, stageRoot: string, expected: TreeSnapshot): Promise<void> {
  const actual = await buildTreeSnapshot(stageRoot)
  if (actual.manifestHash !== expected.manifestHash
    || actual.fileCount !== expected.fileCount
    || actual.totalBytes !== expected.totalBytes) {
    throw new Error(`迁移复制清单不一致: ${relative(sourceRoot, stageRoot) || stageRoot}`)
  }
}

async function buildTreeSnapshot(
  root: string,
  options: { ignoreLinks?: boolean } = {},
): Promise<TreeSnapshot> {
  const entries = await scanTreeEntries(root)
  if (!options.ignoreLinks && entries.links.length > 0) {
    throw new Error(`数据目录包含不允许的符号链接: ${entries.links[0]!.relativePath}`)
  }
  const files: TreeFile[] = []
  let totalBytes = 0
  const manifest = createHash('sha256')
  for (const directory of entries.directories.sort((left, right) => left.localeCompare(right))) {
    manifest.update(`D\0${normalizeRelative(directory)}\n`)
  }
  for (const entry of entries.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const info = await stat(entry.absolutePath)
    const hash = await hashFile(entry.absolutePath)
    const file: TreeFile = {
      ...entry,
      size: info.size,
      mode: info.mode,
      atime: info.atime,
      mtime: info.mtime,
      hash,
    }
    files.push(file)
    totalBytes += info.size
    manifest.update(`${normalizeRelative(entry.relativePath)}\0${info.size}\0${hash}\n`)
  }
  return {
    directories: entries.directories,
    files,
    fileCount: files.length,
    totalBytes,
    manifestHash: manifest.digest('hex'),
  }
}

async function scanTreeEntries(root: string): Promise<{
  directories: string[]
  files: Array<Pick<TreeFile, 'relativePath' | 'absolutePath'>>
  links: Array<Pick<TreeFile, 'relativePath' | 'absolutePath'>>
}> {
  await assertRegularDirectory(root, '数据目录不存在或不是普通目录')
  const directories: string[] = []
  const files: Array<Pick<TreeFile, 'relativePath' | 'absolutePath'>> = []
  const links: Array<Pick<TreeFile, 'relativePath' | 'absolutePath'>> = []
  const queue = ['']
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const current = queue[queueIndex]!
    const absoluteDirectory = current ? join(root, current) : root
    const entries = (await readdir(absoluteDirectory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relativePath = current ? join(current, entry.name) : entry.name
      const absolutePath = join(root, relativePath)
      const info = await lstat(absolutePath)
      if (info.isSymbolicLink()) {
        links.push({ relativePath, absolutePath })
        continue
      }
      if (info.isDirectory()) {
        directories.push(relativePath)
        queue.push(relativePath)
      } else if (info.isFile()) {
        files.push({ relativePath, absolutePath })
      }
    }
  }
  return { directories, files, links }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function fileMatches(path: string, size: number, hash: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink() && info.size === size && await hashFile(path) === hash
  } catch {
    return false
  }
}

function assertExpectedManifest(snapshot: TreeSnapshot, pending: PendingDataRootMigration): void {
  if (!pending.manifestHash || pending.fileCount === undefined || pending.totalBytes === undefined) {
    throw new Error('迁移提交信息不完整')
  }
  if (snapshot.manifestHash !== pending.manifestHash
    || snapshot.fileCount !== pending.fileCount
    || snapshot.totalBytes !== pending.totalBytes) {
    throw new Error('已提交目标与迁移清单不一致')
  }
}

function migrationContext(pending: PendingDataRootMigration): DataRootMigrationFaultContext {
  return {
    sourceDir: pending.sourceDir,
    targetDir: pending.targetDir,
    stageDir: pending.stageDir,
  }
}

function normalizeRelative(path: string): string {
  return path.replace(/\\/gu, '/')
}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: string }).code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
