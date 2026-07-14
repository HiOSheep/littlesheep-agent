// @littlesheep/branding — reads branding.config.json, exports brand constants.
//
// Branding is the single point of identity configuration. Rename the agent,
// change the emoji, or relocate the data dir by editing one JSON file.
//
// Lookup order (first non-empty wins):
//   1. explicit `configPath` argument
//   2. `process.env.LITTLESHEEP_BRANDING`
//   3. `branding.config.json` in cwd
//   4. walk upward from cwd looking for `branding.config.json`
//   5. DEFAULT_BRANDING (no file read)

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Branding configuration shape. */
export interface BrandingConfig {
  /** Display name (e.g. "LittleSheep"). */
  name: string;
  /** CLI command name (e.g. "littlesheep"). */
  cliName: string;
  /** Emoji used in logs/prompts. */
  emoji: string;
  /** One-line tagline. */
  tagline: string;
  /** Data directory name (relative to home). e.g. ".littlesheep" → ~/.littlesheep. */
  dataDir: string;
  /** Display name shown in prompts (may differ from `name` for branding). */
  displayName: string;
}

export type DataRootMigrationPhase = 'requested' | 'copying' | 'verifying' | 'committing' | 'failed';

export interface PendingDataRootMigration {
  id: string;
  sourceDir: string;
  targetDir: string;
  stageDir: string;
  phase: DataRootMigrationPhase;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  error?: string;
}

export interface CompletedDataRootMigration {
  id: string;
  sourceDir: string;
  targetDir: string;
  completedAt: string;
  fileCount: number;
  totalBytes: number;
  manifestHash: string;
}

export interface DataRootLocatorDocument {
  version: 1;
  activeDataDir: string;
  previousDataDir?: string;
  pendingMigration?: PendingDataRootMigration;
  lastMigration?: CompletedDataRootMigration;
}

/** Fallback when no config file is found. */
export const DEFAULT_BRANDING: BrandingConfig = {
  name: 'LittleSheep',
  cliName: 'littlesheep',
  emoji: '🐑',
  tagline: 'High-autonomy agent, hard-control-flow loop.',
  dataDir: '.littlesheep',
  displayName: 'LittleSheep',
};

const FILENAME = 'branding.config.json';
const MAX_WALK_UP = 8;

/** Find branding.config.json by walking up from `start` (default: cwd). */
export function findBrandingConfigPath(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const candidate = join(dir, FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached root
    dir = parent;
  }
  return null;
}

/** Parse + validate a branding config object. Throws on invalid shape. */
export function parseBranding(raw: unknown): BrandingConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('branding: config must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const required = ['name', 'cliName', 'dataDir'];
  for (const key of required) {
    if (typeof obj[key] !== 'string' || (obj[key] as string).length === 0) {
      throw new Error(`branding: missing or invalid "${key}"`);
    }
  }
  return {
    name: obj.name as string,
    cliName: obj.cliName as string,
    emoji: typeof obj.emoji === 'string' ? (obj.emoji as string) : DEFAULT_BRANDING.emoji,
    tagline: typeof obj.tagline === 'string' ? (obj.tagline as string) : DEFAULT_BRANDING.tagline,
    dataDir: obj.dataDir as string,
    displayName: typeof obj.displayName === 'string' ? (obj.displayName as string) : (obj.name as string),
  };
}

/** Load branding from file. Falls back to DEFAULT_BRANDING if not found. */
export async function loadBranding(configPath?: string): Promise<BrandingConfig> {
  const path =
    configPath ??
    process.env.LITTLESHEEP_BRANDING ??
    findBrandingConfigPath();
  if (!path) return { ...DEFAULT_BRANDING };
  const raw = await readFile(path, 'utf8');
  try {
    return parseBranding(JSON.parse(raw));
  } catch (err) {
    throw new Error(`branding: failed to parse ${path}: ${(err as Error).message}`);
  }
}

export function dataRootLocatorPath(branding: BrandingConfig): string {
  const override = process.env.LITTLESHEEP_DATA_LOCATOR;
  return resolve(override || join(homedir(), '.' + branding.cliName + '-location.json'));
}

export function readDataRootLocator(branding: BrandingConfig): DataRootLocatorDocument | undefined {
  try {
    const parsed = JSON.parse(readFileSync(dataRootLocatorPath(branding), 'utf8')) as unknown;
    return parseDataRootLocator(parsed);
  } catch {
    return undefined;
  }
}

/** Resolve the branding-defined default without environment or locator overrides. */
export function resolveDefaultDataDir(branding: BrandingConfig): string {
  // dataDir is a relative path like ".littlesheep"
  if (branding.dataDir.startsWith('~')) {
    return resolve(homedir(), branding.dataDir.slice(1));
  }
  if (branding.dataDir.startsWith('/') || /^[A-Za-z]:/.test(branding.dataDir)) {
    return resolve(branding.dataDir);
  }
  return resolve(homedir(), branding.dataDir);
}

/** Resolve the active data directory (environment override -> locator -> branding default). */
export function resolveDataDir(branding: BrandingConfig): string {
  const override = process.env.LITTLESHEEP_DATA_DIR;
  if (override) return resolve(override);
  const located = readDataRootLocator(branding)?.activeDataDir;
  return located ? resolve(located) : resolveDefaultDataDir(branding);
}

export function parseDataRootLocator(value: unknown): DataRootLocatorDocument | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || typeof raw.activeDataDir !== 'string' || !raw.activeDataDir.trim()) return undefined;
  return {
    version: 1,
    activeDataDir: resolve(raw.activeDataDir),
    previousDataDir: typeof raw.previousDataDir === 'string' && raw.previousDataDir.trim()
      ? resolve(raw.previousDataDir)
      : undefined,
    pendingMigration: parsePendingMigration(raw.pendingMigration),
    lastMigration: parseCompletedMigration(raw.lastMigration),
  };
}

function parsePendingMigration(value: unknown): PendingDataRootMigration | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const phase = raw.phase;
  if (typeof raw.id !== 'string' || !raw.id
    || typeof raw.sourceDir !== 'string' || !raw.sourceDir
    || typeof raw.targetDir !== 'string' || !raw.targetDir
    || typeof raw.stageDir !== 'string' || !raw.stageDir
    || (phase !== 'requested' && phase !== 'copying' && phase !== 'verifying' && phase !== 'committing' && phase !== 'failed')
    || typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string'
    || typeof raw.attempts !== 'number' || !Number.isSafeInteger(raw.attempts) || raw.attempts < 0) return undefined;
  return {
    id: raw.id,
    sourceDir: resolve(raw.sourceDir),
    targetDir: resolve(raw.targetDir),
    stageDir: resolve(raw.stageDir),
    phase,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    attempts: raw.attempts,
    error: typeof raw.error === 'string' ? raw.error : undefined,
  };
}

function parseCompletedMigration(value: unknown): CompletedDataRootMigration | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !raw.id
    || typeof raw.sourceDir !== 'string' || !raw.sourceDir
    || typeof raw.targetDir !== 'string' || !raw.targetDir
    || typeof raw.completedAt !== 'string'
    || typeof raw.fileCount !== 'number' || !Number.isSafeInteger(raw.fileCount) || raw.fileCount < 0
    || typeof raw.totalBytes !== 'number' || !Number.isSafeInteger(raw.totalBytes) || raw.totalBytes < 0
    || typeof raw.manifestHash !== 'string' || !raw.manifestHash) return undefined;
  return {
    id: raw.id,
    sourceDir: resolve(raw.sourceDir),
    targetDir: resolve(raw.targetDir),
    completedAt: raw.completedAt,
    fileCount: raw.fileCount,
    totalBytes: raw.totalBytes,
    manifestHash: raw.manifestHash,
  };
}

/** Common subdirectories under the data dir. */
export function dataSubdirs(branding: BrandingConfig): {
  root: string;
  sessions: string;
  memory: string;
  skills: string;
  config: string;
  quarantine: string;
  backups: string;
  experience: string;
  archive: string;
  vectors: string;
  executionLogs: string;
  channels: string;
  plugins: string;
  pluginData: string;
  attachmentCache: string;
  workplace: string;
} {
  const root = resolveDataDir(branding);
  return {
    root,
    sessions: join(root, 'sessions'),
    memory: join(root, 'memory'),
    skills: join(root, 'skills'),
    config: join(root, 'config'),
    quarantine: join(root, 'quarantine'),
    backups: join(root, 'backups'),
    experience: join(root, 'experience'),
    archive: join(root, 'archive'),
    vectors: join(root, 'vectors'),
    executionLogs: join(root, 'execution-logs'),
    channels: join(root, 'channels'),
    plugins: join(root, 'plugins'),
    pluginData: join(root, 'plugin-data'),
    attachmentCache: join(root, 'attachment-cache'),
    workplace: join(root, 'workplace'),
  };
}
