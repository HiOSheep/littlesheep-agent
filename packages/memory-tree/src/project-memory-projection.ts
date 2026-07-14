import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { atomicWrite } from '@littlesheep/memory-core';
import { InjectionTier, type MemoryNode, type MemoryResourceRegistration } from './types.js';
import { MemoryRepository } from './memory-repository.js';

const REGISTRY_VERSION = 1 as const;
const PRIVATE_PROJECTION_VERSION = 1 as const;
const PRIVATE_PROJECTION_DIR = '.littlesheep';
const PRIVATE_PROJECTION_FILE = 'project-memory.private.json';
const PRIVATE_PROJECTION_MAX_ENTRIES = 200;
const SHAREABLE_EXPORT_MAX_ENTRIES = 100;
const SHAREABLE_MIN_CONFIDENCE = 0.75;
const GIT_IGNORE_PATTERN = '/.littlesheep/';

export interface ProjectMemoryTarget {
  id: string;
  name: string;
  path: string;
}

export interface ProjectMemoryProjectionEntry {
  memoryId: string;
  tier: InjectionTier;
  summary: string;
  content: string;
  retrievalKeys: string[];
  updatedAt: string;
}

export interface ProjectMemoryPrivateProjection {
  version: 1;
  kind: 'littlesheep-project-memory-private';
  authority: 'derived-projection';
  privacy: 'project-private';
  project: { id: string; name: string };
  generatedAt: string;
  sourceRevision: string;
  entries: ProjectMemoryProjectionEntry[];
  omittedEntryCount: number;
  notice: string;
}

export type ProjectMemoryProjectionStatus =
  | 'disabled'
  | 'missing'
  | 'ready'
  | 'stale'
  | 'conflict';

export interface ProjectMemoryProjectionState {
  projectId: string;
  projectName: string;
  projectPath: string;
  enabled: boolean;
  projectionPath: string;
  projectionExists: boolean;
  safeToRemove: boolean;
  status: ProjectMemoryProjectionStatus;
  gitRepository: boolean;
  gitIgnored: boolean;
  gitIgnorePattern: string;
  sourceRevision?: string;
  lastWrittenFileHash?: string;
  entryCount?: number;
  omittedEntryCount?: number;
  lastSyncedAt?: string;
  conflictReason?: string;
}

export interface ProjectMemoryShareableExportResult {
  outputPath: string;
  entryCount: number;
  omittedEntryCount: number;
  contentHash: string;
  generatedAt: string;
}

interface ShareableProjectMemoryEntry {
  summary: string;
  content: string;
  retrievalKeys: string[];
}

interface StoredProjectProjectionState {
  projectId: string;
  projectName: string;
  projectPath: string;
  enabled: boolean;
  sourceRevision?: string;
  lastWrittenFileHash?: string;
  entryCount?: number;
  omittedEntryCount?: number;
  lastSyncedAt?: string;
  conflictReason?: string;
}

interface ProjectionRegistryDocument {
  version: 1;
  projects: Record<string, StoredProjectProjectionState>;
}

export interface ProjectMemoryProjectionServiceOptions {
  dataDir: string;
  repository: MemoryRepository;
}

export class ProjectMemoryProjectionService {
  private readonly dataDir: string;
  private readonly repository: MemoryRepository;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(options: ProjectMemoryProjectionServiceOptions) {
    this.dataDir = resolve(options.dataDir);
    this.repository = options.repository;
  }

  get registryPath(): string {
    return join(this.dataDir, 'memory-tree', 'project-projections.json');
  }

  projectionPath(project: ProjectMemoryTarget): string {
    return join(resolve(project.path), PRIVATE_PROJECTION_DIR, PRIVATE_PROJECTION_FILE);
  }

  async getState(project: ProjectMemoryTarget): Promise<ProjectMemoryProjectionState> {
    const registry = await this.readRegistry();
    return this.inspectState(project, registry.projects[project.id]);
  }

  async listStates(projects: ProjectMemoryTarget[]): Promise<ProjectMemoryProjectionState[]> {
    const registry = await this.readRegistry();
    return Promise.all(projects.map((project) => this.inspectState(project, registry.projects[project.id])));
  }

  async rebind(
    previous: ProjectMemoryTarget,
    project: ProjectMemoryTarget,
  ): Promise<ProjectMemoryProjectionState> {
    if (previous.id !== project.id) throw new Error('Project memory rebind requires the same stable project id.');
    return this.serialize(async () => {
      await assertProjectDirectory(project);
      await assertProjectionContainerSafe(project.path);
      const registry = await this.readRegistry();
      const stored = registry.projects[project.id];
      if (!stored) return this.inspectState(project, undefined);
      if (!samePath(stored.projectPath, previous.path) && !samePath(stored.projectPath, project.path)) {
        throw new Error(`Project memory projection is bound to a different path: ${stored.projectPath}`);
      }
      stored.projectName = project.name;
      stored.projectPath = resolve(project.path);
      await this.persistRegistry(registry);

      const projectionPath = this.projectionPath(project);
      if (stored.enabled && !stored.conflictReason && existsSync(projectionPath)) {
        const currentHash = sha256(await readFile(projectionPath, 'utf8'));
        if (stored.lastWrittenFileHash && currentHash === stored.lastWrittenFileHash) {
          return this.syncUnlocked(project, registry, { force: false });
        }
      }
      return this.inspectState(project, stored);
    });
  }

  async enable(
    project: ProjectMemoryTarget,
    options: { overwriteExisting?: boolean } = {},
  ): Promise<ProjectMemoryProjectionState> {
    return this.serialize(async () => {
      await assertProjectDirectory(project);
      await assertProjectionContainerSafe(project.path);
      const registry = await this.readRegistry();
      registry.projects[project.id] = {
        ...(registry.projects[project.id] ?? {}),
        projectId: project.id,
        projectName: project.name,
        projectPath: resolve(project.path),
        enabled: true,
      };
      await this.persistRegistry(registry);
      return this.syncUnlocked(project, registry, { force: options.overwriteExisting === true });
    });
  }

  async sync(
    project: ProjectMemoryTarget,
    options: { force?: boolean } = {},
  ): Promise<ProjectMemoryProjectionState> {
    return this.serialize(async () => {
      await assertProjectDirectory(project);
      await assertProjectionContainerSafe(project.path);
      const registry = await this.readRegistry();
      const stored = registry.projects[project.id];
      if (!stored?.enabled) throw new Error('Project memory projection is not enabled for this project.');
      return this.syncUnlocked(project, registry, options);
    });
  }

  async disable(
    project: ProjectMemoryTarget,
    options: { removeProjection?: boolean } = {},
  ): Promise<ProjectMemoryProjectionState> {
    return this.serialize(async () => {
      await assertProjectionContainerSafe(project.path);
      const registry = await this.readRegistry();
      const previous = registry.projects[project.id];
      const projectionPath = this.projectionPath(project);
      let removedProjection: string | undefined;
      if (options.removeProjection && existsSync(projectionPath)) {
        removedProjection = await readFile(projectionPath, 'utf8');
        if (!previous?.lastWrittenFileHash || sha256(removedProjection) !== previous.lastWrittenFileHash) {
          throw new Error('LittleSheep will not remove a projection file that is not the last verified file it generated.');
        }
        await rm(projectionPath, { force: true });
      }
      registry.projects[project.id] = {
        ...(previous ?? {}),
        projectId: project.id,
        projectName: project.name,
        projectPath: resolve(project.path),
        enabled: false,
        conflictReason: undefined,
      };
      if (options.removeProjection) {
        registry.projects[project.id]!.lastWrittenFileHash = undefined;
        registry.projects[project.id]!.sourceRevision = undefined;
        registry.projects[project.id]!.entryCount = undefined;
        registry.projects[project.id]!.omittedEntryCount = undefined;
        registry.projects[project.id]!.lastSyncedAt = undefined;
      }
      try {
        await this.persistRegistry(registry);
      } catch (error) {
        if (removedProjection !== undefined) await atomicWrite(projectionPath, removedProjection);
        throw error;
      }
      await this.removeProjectionResource(project.id);
      return this.inspectState(project, registry.projects[project.id]);
    });
  }

  async exportShareable(
    project: ProjectMemoryTarget,
    outputPath: string,
    options: { overwriteExisting?: boolean } = {},
  ): Promise<ProjectMemoryShareableExportResult> {
    return this.serialize(async () => {
      await assertProjectDirectory(project);
      const targetPath = resolve(outputPath);
      if (samePath(targetPath, this.projectionPath(project))) {
        throw new Error('Shareable export cannot overwrite the private runtime projection.');
      }
      if (existsSync(targetPath) && !options.overwriteExisting) {
        throw new Error('Shareable export target already exists; explicit overwrite approval is required.');
      }
      const { entries, omittedEntryCount } = await this.selectProjectionEntries(
        project,
        SHAREABLE_EXPORT_MAX_ENTRIES,
        true,
      );
      const generatedAt = new Date().toISOString();
      const content = renderShareableMarkdown(project, entries, omittedEntryCount, generatedAt);
      await mkdir(dirname(targetPath), { recursive: true });
      await atomicWrite(targetPath, content);
      return {
        outputPath: targetPath,
        entryCount: entries.length,
        omittedEntryCount,
        contentHash: sha256(content),
        generatedAt,
      };
    });
  }

  private async syncUnlocked(
    project: ProjectMemoryTarget,
    registry: ProjectionRegistryDocument,
    options: { force?: boolean },
  ): Promise<ProjectMemoryProjectionState> {
    const stored = registry.projects[project.id]!;
    const projectionPath = this.projectionPath(project);
    if (existsSync(projectionPath)) {
      const currentHash = sha256(await readFile(projectionPath, 'utf8'));
      if (!options.force && (!stored.lastWrittenFileHash || currentHash !== stored.lastWrittenFileHash)) {
        stored.conflictReason = stored.lastWrittenFileHash
          ? 'The generated projection changed outside LittleSheep after the last sync.'
          : 'A projection file already exists but is not registered as a LittleSheep-generated file.';
        await this.persistRegistry(registry);
        return this.inspectState(project, stored);
      }
    }

    const { entries, omittedEntryCount } = await this.selectProjectionEntries(
      project,
      PRIVATE_PROJECTION_MAX_ENTRIES,
      false,
    );
    const generatedAt = new Date().toISOString();
    const sourceRevision = projectionRevision(entries);
    const document: ProjectMemoryPrivateProjection = {
      version: PRIVATE_PROJECTION_VERSION,
      kind: 'littlesheep-project-memory-private',
      authority: 'derived-projection',
      privacy: 'project-private',
      project: { id: project.id, name: project.name },
      generatedAt,
      sourceRevision,
      entries,
      omittedEntryCount,
      notice: '此文件派生自 LittleSheep 用户数据中的权威项目记忆。不要把它当作权威来源；提交到版本库前必须检查隐私。',
    };
    const serialized = JSON.stringify(document, null, 2);
    const previousProjection = existsSync(projectionPath)
      ? await readFile(projectionPath, 'utf8')
      : undefined;
    await mkdir(dirname(projectionPath), { recursive: true });
    await atomicWrite(projectionPath, serialized);
    const fileHash = sha256(serialized);
    stored.projectName = project.name;
    stored.projectPath = resolve(project.path);
    stored.sourceRevision = sourceRevision;
    stored.lastWrittenFileHash = fileHash;
    stored.entryCount = entries.length;
    stored.omittedEntryCount = omittedEntryCount;
    stored.lastSyncedAt = generatedAt;
    stored.conflictReason = undefined;
    try {
      await this.persistRegistry(registry);
    } catch (error) {
      if (previousProjection === undefined) await rm(projectionPath, { force: true });
      else await atomicWrite(projectionPath, previousProjection);
      throw error;
    }
    await this.registerProjectionResource(project, projectionPath, stored, fileHash, 'ready');
    return this.inspectState(project, stored);
  }

  private async selectProjectionEntries(
    project: ProjectMemoryTarget,
    limit: number,
    shareable: false,
  ): Promise<{ entries: ProjectMemoryProjectionEntry[]; omittedEntryCount: number }>;
  private async selectProjectionEntries(
    project: ProjectMemoryTarget,
    limit: number,
    shareable: true,
  ): Promise<{ entries: ShareableProjectMemoryEntry[]; omittedEntryCount: number }>;
  private async selectProjectionEntries(
    project: ProjectMemoryTarget,
    limit: number,
    shareable: boolean,
  ): Promise<{
    entries: Array<ProjectMemoryProjectionEntry | ShareableProjectMemoryEntry>;
    omittedEntryCount: number;
  }> {
    const nodes = (await this.repository.listNodes('project'))
      .filter((node) => node.status === 'active' && node.scopeKey && samePath(node.scopeKey, project.path))
      .sort((left, right) => left.tier - right.tier || right.updatedAt.localeCompare(left.updatedAt));
    const entries: Array<ProjectMemoryProjectionEntry | ShareableProjectMemoryEntry> = [];
    let omittedEntryCount = 0;
    for (const node of nodes) {
      if (entries.length >= limit) {
        omittedEntryCount += 1;
        continue;
      }
      const entry = shareable
        ? toShareableProjectionEntry(node, project.path)
        : toPrivateProjectionEntry(node, project.path);
      if (!entry) {
        omittedEntryCount += 1;
        continue;
      }
      entries.push(entry);
    }
    return { entries, omittedEntryCount };
  }

  private async registerProjectionResource(
    project: ProjectMemoryTarget,
    projectionPath: string,
    stored: StoredProjectProjectionState,
    fileHash: string,
    projectionStatus: ProjectMemoryProjectionStatus,
  ): Promise<void> {
    const entryCount = stored.entryCount ?? 0;
    const omittedEntryCount = stored.omittedEntryCount ?? 0;
    const updatedAt = stored.lastSyncedAt ?? new Date().toISOString();
    const resource: MemoryResourceRegistration = {
      version: 1,
      id: projectProjectionResourceId(project.id),
      kind: 'project-memory-projection',
      title: `${project.name} 项目记忆私有投影`,
      description: `由用户数据中的权威项目记忆派生；包含 ${entryCount} 条白名单记忆。`,
      tier: InjectionTier.T2_RELEVANT,
      branch: 'project',
      scope: 'project',
      scopeKey: resolve(project.path),
      authority: 'derived',
      privacy: 'project-private',
      source: { kind: 'file', path: projectionPath, contentHash: `sha256:${fileHash}` },
      indexKeys: ['project memory projection', '项目记忆投影', project.id, project.name],
      status: 'active',
      registryGroup: projectProjectionRegistryGroup(project.id),
      registeredAt: updatedAt,
      updatedAt,
      metadata: {
        projectId: project.id,
        sourceRevision: stored.sourceRevision,
        entryCount,
        omittedEntryCount,
        gitIgnorePattern: GIT_IGNORE_PATTERN,
        projectionStatus,
      },
    };
    await this.repository.replaceResourceGroup(resource.registryGroup, [resource], { staleMode: 'remove' });
  }

  private async removeProjectionResource(projectId: string): Promise<void> {
    await this.repository.replaceResourceGroup(projectProjectionRegistryGroup(projectId), [], { staleMode: 'remove' });
  }

  private async reconcileProjectionResource(
    project: ProjectMemoryTarget,
    stored: StoredProjectProjectionState | undefined,
    state: ProjectMemoryProjectionState,
    currentFileHash?: string,
  ): Promise<void> {
    if (!stored?.enabled || state.status === 'disabled') {
      await this.removeProjectionResource(project.id);
      return;
    }
    if ((state.status === 'ready' || state.status === 'stale') && currentFileHash) {
      await this.registerProjectionResource(
        project,
        state.projectionPath,
        stored,
        currentFileHash,
        state.status,
      );
      return;
    }
    const existing = await this.repository.getResource(projectProjectionResourceId(project.id));
    if (!existing) return;
    const targetStatus = state.status === 'missing' ? 'missing' : 'conflict';
    if (existing.status === targetStatus && existing.metadata?.projectionStatus === state.status) return;
    await this.repository.replaceResourceGroup(existing.registryGroup, [{
      ...existing,
      status: targetStatus,
      updatedAt: new Date().toISOString(),
      metadata: { ...existing.metadata, projectionStatus: state.status },
    }], { staleMode: 'remove' });
  }

  private async inspectState(
    project: ProjectMemoryTarget,
    stored: StoredProjectProjectionState | undefined,
  ): Promise<ProjectMemoryProjectionState> {
    const projectionPath = this.projectionPath(project);
    const gitRepository = existsSync(join(resolve(project.path), '.git'));
    const gitIgnored = await hasProjectionGitIgnore(project.path);
    const projectionExists = existsSync(projectionPath);
    const currentHash = projectionExists ? sha256(await readFile(projectionPath, 'utf8')) : undefined;
    const safeToRemove = !!stored?.lastWrittenFileHash && currentHash === stored.lastWrittenFileHash;
    if (!stored?.enabled) {
      const state: ProjectMemoryProjectionState = {
        projectId: project.id,
        projectName: project.name,
        projectPath: resolve(project.path),
        enabled: false,
        projectionPath,
        projectionExists,
        safeToRemove,
        status: 'disabled',
        gitRepository,
        gitIgnored,
        gitIgnorePattern: GIT_IGNORE_PATTERN,
        sourceRevision: stored?.sourceRevision,
        lastWrittenFileHash: stored?.lastWrittenFileHash,
        entryCount: stored?.entryCount,
        omittedEntryCount: stored?.omittedEntryCount,
        lastSyncedAt: stored?.lastSyncedAt,
      };
      await this.reconcileProjectionResource(project, stored, state);
      return state;
    }
    if (stored.conflictReason) {
      const state = stateFromStored(project, projectionPath, stored, 'conflict', gitRepository, gitIgnored, projectionExists, safeToRemove);
      await this.reconcileProjectionResource(project, stored, state);
      return state;
    }
    if (!projectionExists || !currentHash) {
      const state = stateFromStored(project, projectionPath, stored, 'missing', gitRepository, gitIgnored, projectionExists, safeToRemove);
      await this.reconcileProjectionResource(project, stored, state);
      return state;
    }
    if (!stored.lastWrittenFileHash || currentHash !== stored.lastWrittenFileHash) {
      const state = stateFromStored(project, projectionPath, {
        ...stored,
        conflictReason: 'The generated projection no longer matches the last LittleSheep write.',
      }, 'conflict', gitRepository, gitIgnored, projectionExists, safeToRemove);
      await this.reconcileProjectionResource(project, stored, state);
      return state;
    }
    const { entries } = await this.selectProjectionEntries(project, PRIVATE_PROJECTION_MAX_ENTRIES, false);
    const currentRevision = projectionRevision(entries);
    const state = stateFromStored(
      project,
      projectionPath,
      stored,
      currentRevision === stored.sourceRevision ? 'ready' : 'stale',
      gitRepository,
      gitIgnored,
      projectionExists,
      safeToRemove,
    );
    await this.reconcileProjectionResource(project, stored, state, currentHash);
    return state;
  }

  private async readRegistry(): Promise<ProjectionRegistryDocument> {
    if (!existsSync(this.registryPath)) return { version: REGISTRY_VERSION, projects: {} };
    const parsed = JSON.parse(await readFile(this.registryPath, 'utf8')) as unknown;
    if (!isProjectionRegistryDocument(parsed)) {
      throw new Error('Project memory projection registry has an unsupported or invalid format.');
    }
    return parsed;
  }

  private async persistRegistry(document: ProjectionRegistryDocument): Promise<void> {
    await mkdir(dirname(this.registryPath), { recursive: true });
    await atomicWrite(this.registryPath, JSON.stringify(document, null, 2));
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail.catch(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    this.operationTail = previous.then(() => gate);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function projectProjectionResourceId(projectId: string): string {
  return `project-memory-projection:${projectId}`;
}

export function projectProjectionRegistryGroup(projectId: string): string {
  return `project-memory-projection:${projectId}`;
}

function toPrivateProjectionEntry(
  node: MemoryNode,
  projectPath: string,
): ProjectMemoryProjectionEntry | undefined {
  if (node.tier === InjectionTier.T3_DETAIL) return undefined;
  const summary = sanitizeProjectionText(node.summary, projectPath);
  const content = sanitizeProjectionText(node.content, projectPath);
  if (!summary || !content) return undefined;
  return {
    memoryId: node.id,
    tier: node.tier,
    summary,
    content,
    retrievalKeys: node.retrievalKeys
      .map((key) => sanitizeProjectionText(key, projectPath))
      .filter((key): key is string => !!key)
      .slice(0, 16),
    updatedAt: node.updatedAt,
  };
}

function toShareableProjectionEntry(
  node: MemoryNode,
  projectPath: string,
): ShareableProjectMemoryEntry | undefined {
  if (node.tier === InjectionTier.T3_DETAIL || node.confidence < SHAREABLE_MIN_CONFIDENCE) return undefined;
  const summary = sanitizeProjectionText(node.summary, projectPath);
  const content = sanitizeProjectionText(node.content, projectPath);
  if (!summary || !content) return undefined;
  return {
    summary,
    content,
    retrievalKeys: node.retrievalKeys
      .map((key) => sanitizeProjectionText(key, projectPath))
      .filter((key): key is string => !!key)
      .slice(0, 12),
  };
}

function sanitizeProjectionText(value: string, projectPath: string): string | undefined {
  const text = value.replace(/[\u0000\u200B-\u200D\uFEFF]/gu, '').trim();
  if (!text || containsSensitiveSecret(text)) return undefined;
  const projectPattern = escapeRegExp(resolve(projectPath).replace(/[\\/]+$/u, ''));
  return text
    .replace(new RegExp(projectPattern, 'giu'), '<project-root>')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`]+/gu, '<local-path>')
    .slice(0, 4_000);
}

function containsSensitiveSecret(value: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/iu.test(value)
    || /\bsk-[A-Za-z0-9_-]{12,}\b/iu.test(value)
    || /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s]{8,}/iu.test(value);
}

function projectionRevision(entries: ProjectMemoryProjectionEntry[]): string {
  return sha256(JSON.stringify(entries.map((entry) => ({
    memoryId: entry.memoryId,
    tier: entry.tier,
    summary: entry.summary,
    content: entry.content,
    retrievalKeys: entry.retrievalKeys,
    updatedAt: entry.updatedAt,
  }))));
}

function renderShareableMarkdown(
  project: ProjectMemoryTarget,
  entries: ShareableProjectMemoryEntry[],
  omittedEntryCount: number,
  generatedAt: string,
): string {
  const sections = entries.map((entry) => [
    `## ${escapeMarkdownHeading(entry.summary)}`,
    '',
    entry.content,
    '',
    entry.retrievalKeys.length > 0 ? `关键词：${entry.retrievalKeys.join('、')}` : '',
  ].filter(Boolean).join('\n'));
  return [
    '# LittleSheep 项目记忆共享导出',
    '',
    `项目：${escapeMarkdownHeading(project.name)}`,
    `生成时间：${generatedAt}`,
    '',
    '> 这是经过白名单过滤的共享快照，不是 LS 的运行时权威记忆，也不会反向覆盖用户数据。',
    '',
    ...sections,
    '',
    `已导出 ${entries.length} 条；因层级、置信度或敏感信息过滤省略 ${omittedEntryCount} 条。`,
    '',
  ].join('\n');
}

function escapeMarkdownHeading(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').replace(/#+/gu, '').trim();
}

function stateFromStored(
  project: ProjectMemoryTarget,
  projectionPath: string,
  stored: StoredProjectProjectionState,
  status: ProjectMemoryProjectionStatus,
  gitRepository: boolean,
  gitIgnored: boolean,
  projectionExists: boolean,
  safeToRemove: boolean,
): ProjectMemoryProjectionState {
  return {
    projectId: project.id,
    projectName: project.name,
    projectPath: resolve(project.path),
    enabled: stored.enabled,
    projectionPath,
    projectionExists,
    safeToRemove,
    status,
    gitRepository,
    gitIgnored,
    gitIgnorePattern: GIT_IGNORE_PATTERN,
    sourceRevision: stored.sourceRevision,
    lastWrittenFileHash: stored.lastWrittenFileHash,
    entryCount: stored.entryCount,
    omittedEntryCount: stored.omittedEntryCount,
    lastSyncedAt: stored.lastSyncedAt,
    conflictReason: stored.conflictReason,
  };
}

async function assertProjectDirectory(project: ProjectMemoryTarget): Promise<void> {
  if (!project.id.trim() || !project.name.trim() || !project.path.trim()) {
    throw new Error('Project id, name and path are required.');
  }
  const info = await stat(resolve(project.path)).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Project directory does not exist: ${project.path}`);
}

async function assertProjectionContainerSafe(projectPath: string): Promise<void> {
  const container = join(resolve(projectPath), PRIVATE_PROJECTION_DIR);
  const info = await lstat(container).catch(() => undefined);
  if (!info) return;
  if (info.isSymbolicLink()) {
    throw new Error('The project .littlesheep directory cannot be a symbolic link or junction.');
  }
  if (!info.isDirectory()) {
    throw new Error('The project .littlesheep path exists but is not a directory.');
  }
}

async function hasProjectionGitIgnore(projectPath: string): Promise<boolean> {
  const file = join(resolve(projectPath), '.gitignore');
  if (!existsSync(file)) return false;
  const entries = (await readFile(file, 'utf8'))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return entries.some((entry) => {
    const normalized = entry.replace(/\\/gu, '/').replace(/^\.\//u, '');
    return normalized === '.littlesheep'
      || normalized === '.littlesheep/'
      || normalized === '/.littlesheep'
      || normalized === '/.littlesheep/';
  });
}

function isProjectionRegistryDocument(value: unknown): value is ProjectionRegistryDocument {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.version !== REGISTRY_VERSION
    || !record.projects
    || typeof record.projects !== 'object'
    || Array.isArray(record.projects)) return false;
  return Object.entries(record.projects as Record<string, unknown>).every(([projectId, state]) => (
    isStoredProjectProjectionState(state) && state.projectId === projectId
  ));
}

function isStoredProjectProjectionState(value: unknown): value is StoredProjectProjectionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return isNonEmptyString(state.projectId)
    && isNonEmptyString(state.projectName)
    && isNonEmptyString(state.projectPath)
    && typeof state.enabled === 'boolean'
    && isOptionalString(state.sourceRevision)
    && isOptionalString(state.lastWrittenFileHash)
    && isOptionalNonNegativeInteger(state.entryCount)
    && isOptionalNonNegativeInteger(state.omittedEntryCount)
    && isOptionalTimestamp(state.lastSyncedAt)
    && isOptionalString(state.conflictReason);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalNonNegativeInteger(value: unknown): value is number | undefined {
  return value === undefined || (Number.isInteger(value) && Number(value) >= 0);
}

function isOptionalTimestamp(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function samePath(left: string, right: string): boolean {
  return resolve(left).replace(/[\\/]+$/u, '').toLocaleLowerCase()
    === resolve(right).replace(/[\\/]+$/u, '').toLocaleLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
