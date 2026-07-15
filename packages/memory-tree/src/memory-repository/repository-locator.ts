// Owns the durable backend-version locator used by Memory v2 -> v3 migration.

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { durableAtomicWriteJson } from '../v3/durable-json.js';
import type { MemoryRepositoryBackendKind } from './contracts.js';

export const MEMORY_REPOSITORY_LOCATOR_FILE = 'repository-version.json';

export type MemoryV3MigrationPhase =
  | 'requested'
  | 'snapshot'
  | 'building'
  | 'validating'
  | 'ready'
  | 'committing'
  | 'recovery';

export type MemoryV3RollbackPhase =
  | 'requested'
  | 'validating'
  | 'committing'
  | 'recovery';

export interface PendingMemoryV3Migration {
  id: string;
  phase: MemoryV3MigrationPhase;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  sourceIndexHash?: string;
  sourceManifestHash?: string;
  snapshotManifestHash?: string;
  validationHash?: string;
  nodeCount?: number;
  resourceCount?: number;
  error?: string;
}

export interface PendingMemoryV3Rollback {
  id: string;
  phase: MemoryV3RollbackPhase;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface CompletedMemoryV3Migration {
  id: string;
  sourceIndexHash: string;
  sourceManifestHash: string;
  snapshotManifestHash: string;
  validationHash: string;
  nodeCount: number;
  resourceCount: number;
  snapshotRelativePath: string;
  completedAt: string;
}

export interface MemoryRepositoryLocator {
  version: 1;
  activeBackend: MemoryRepositoryBackendKind;
  previousBackend?: MemoryRepositoryBackendKind;
  pendingMigration?: PendingMemoryV3Migration;
  pendingRollback?: PendingMemoryV3Rollback;
  lastMigration?: CompletedMemoryV3Migration;
  updatedAt: string;
}

export function memoryRepositoryLocatorPath(dataDir: string): string {
  return join(dataDir, 'memory-tree', MEMORY_REPOSITORY_LOCATOR_FILE);
}

export function createDefaultMemoryRepositoryLocator(now = new Date().toISOString()): MemoryRepositoryLocator {
  return { version: 1, activeBackend: 'v2', updatedAt: now };
}

export async function readMemoryRepositoryLocator(dataDir: string): Promise<MemoryRepositoryLocator | undefined> {
  try {
    return parseRequiredLocator(JSON.parse(await readFile(memoryRepositoryLocatorPath(dataDir), 'utf8')) as unknown);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

export function readMemoryRepositoryLocatorSync(dataDir: string): MemoryRepositoryLocator | undefined {
  try {
    return parseRequiredLocator(JSON.parse(readFileSync(memoryRepositoryLocatorPath(dataDir), 'utf8')) as unknown);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

export function writeMemoryRepositoryLocator(dataDir: string, locator: MemoryRepositoryLocator): Promise<void> {
  const parsed = parseMemoryRepositoryLocator(locator);
  if (!parsed) throw new Error('Refusing to write an invalid memory repository locator.');
  return durableAtomicWriteJson(memoryRepositoryLocatorPath(dataDir), parsed);
}

export function parseMemoryRepositoryLocator(value: unknown): MemoryRepositoryLocator | null {
  if (!value || typeof value !== 'object') return null;
  const locator = value as Partial<MemoryRepositoryLocator>;
  if (locator.version !== 1 || !isBackend(locator.activeBackend) || !validTimestamp(locator.updatedAt)) return null;
  if (locator.previousBackend !== undefined && !isBackend(locator.previousBackend)) return null;
  if (locator.pendingMigration && !validPending(locator.pendingMigration)) return null;
  if (locator.pendingRollback && !validPendingRollback(locator.pendingRollback)) return null;
  if (locator.lastMigration && !validCompleted(locator.lastMigration)) return null;
  if (locator.pendingMigration && locator.pendingRollback) return null;
  if (locator.pendingMigration && locator.activeBackend !== 'v2') return null;
  if (locator.pendingRollback && locator.activeBackend !== 'v3') return null;
  if (locator.activeBackend === 'v3' && !locator.lastMigration) return null;
  return structuredClone(locator as MemoryRepositoryLocator);
}

function parseRequiredLocator(value: unknown): MemoryRepositoryLocator {
  const locator = parseMemoryRepositoryLocator(value);
  if (!locator) throw new Error('Memory repository locator is invalid; refusing to guess the active backend.');
  return locator;
}

function validPending(value: PendingMemoryV3Migration): boolean {
  return typeof value.id === 'string' && value.id.length > 0
    && ['requested', 'snapshot', 'building', 'validating', 'ready', 'committing', 'recovery'].includes(value.phase)
    && Number.isInteger(value.attempts) && value.attempts >= 0
    && validTimestamp(value.createdAt) && validTimestamp(value.updatedAt)
    && optionalHash(value.sourceIndexHash) && optionalHash(value.sourceManifestHash)
    && optionalHash(value.snapshotManifestHash) && optionalHash(value.validationHash)
    && optionalCount(value.nodeCount) && optionalCount(value.resourceCount)
    && (value.error === undefined || typeof value.error === 'string');
}

function validPendingRollback(value: PendingMemoryV3Rollback): boolean {
  return typeof value.id === 'string' && value.id.length > 0
    && ['requested', 'validating', 'committing', 'recovery'].includes(value.phase)
    && Number.isInteger(value.attempts) && value.attempts >= 0
    && validTimestamp(value.createdAt) && validTimestamp(value.updatedAt)
    && (value.error === undefined || typeof value.error === 'string');
}

function validCompleted(value: CompletedMemoryV3Migration): boolean {
  return typeof value.id === 'string' && value.id.length > 0
    && validHash(value.sourceIndexHash) && validHash(value.sourceManifestHash)
    && validHash(value.snapshotManifestHash) && validHash(value.validationHash)
    && Number.isInteger(value.nodeCount) && value.nodeCount >= 0
    && Number.isInteger(value.resourceCount) && value.resourceCount >= 0
    && typeof value.snapshotRelativePath === 'string' && value.snapshotRelativePath.length > 0
    && validTimestamp(value.completedAt);
}

function isBackend(value: unknown): value is MemoryRepositoryBackendKind {
  return value === 'v2' || value === 'v3';
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function optionalHash(value: unknown): boolean {
  return value === undefined || validHash(value);
}

function optionalCount(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && Number(value) >= 0);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
