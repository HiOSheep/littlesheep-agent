// Owns bounded, sharded compatibility ledgers for the Memory v3 repository facade.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  LogFn,
  MemoryManagementAuditRecord,
  MemoryMigrationRecord,
  MemoryResourceManagementAuditRecord,
  MemoryScope,
  MemoryWriteAuditRecord,
  MemoryWriteIntent,
  QueuedMemoryWrite,
} from '../types.js';
import { durableAtomicWriteJson } from '../v3/durable-json.js';

const DEFAULT_MAX_AUDIT_RECORDS = 2_000;
const DEFAULT_MAX_RECOVERY_RECORDS = 2_000;
const MAX_SCAN_RECORDS = 20_000;

export interface MemoryV3ScopeAlias {
  version: 1;
  id: string;
  scope: Exclude<MemoryScope, 'global'>;
  storageKey: string;
  currentKey: string;
  updatedAt: string;
}

export interface MemoryV3RepositoryTransaction {
  version: 1;
  id: string;
  idempotencyKey: string;
  kind: 'project-rebind' | 'resource-mutation';
  payload: Record<string, unknown>;
  completedSteps: string[];
  state: 'pending' | 'recovery';
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryV3LedgerSnapshot {
  writeAudit: MemoryWriteAuditRecord[];
  managementAudit: MemoryManagementAuditRecord[];
  resourceManagementAudit: MemoryResourceManagementAuditRecord[];
  recoveryQueue: QueuedMemoryWrite[];
  migrations: Record<string, MemoryMigrationRecord>;
}

export interface MemoryV3RepositoryLedgerOptions {
  dataDir: string;
  maxAuditRecords?: number;
  maxRecoveryRecords?: number;
  log?: LogFn;
}

export class MemoryV3RepositoryLedger {
  readonly rootDir: string;
  private readonly maxAuditRecords: number;
  private readonly maxRecoveryRecords: number;
  private readonly log?: LogFn;
  private readonly writeAudits = new Map<string, MemoryWriteAuditRecord>();
  private readonly managementAudits = new Map<string, MemoryManagementAuditRecord>();
  private readonly resourceAudits = new Map<string, MemoryResourceManagementAuditRecord>();
  private readonly recovery = new Map<string, QueuedMemoryWrite>();
  private readonly migrations = new Map<string, MemoryMigrationRecord>();
  private readonly aliases = new Map<string, MemoryV3ScopeAlias>();
  private readonly transactions = new Map<string, MemoryV3RepositoryTransaction>();
  private initialized = false;
  private initialization?: Promise<void>;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: MemoryV3RepositoryLedgerOptions) {
    this.rootDir = join(options.dataDir, 'memory-tree', 'v3', 'repository');
    this.maxAuditRecords = positiveLimit(options.maxAuditRecords, DEFAULT_MAX_AUDIT_RECORDS);
    this.maxRecoveryRecords = positiveLimit(options.maxRecoveryRecords, DEFAULT_MAX_RECOVERY_RECORDS);
    this.log = options.log;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialization ??= this.exclusive(() => this.initializeOnce()).catch((error) => {
      this.initialization = undefined;
      throw error;
    });
    await this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await this.loadCategory('write-audit', this.writeAudits, isWriteAudit);
    await this.loadCategory('management-audit', this.managementAudits, isManagementAudit);
    await this.loadCategory('resource-audit', this.resourceAudits, isResourceAudit);
    await this.loadCategory('recovery', this.recovery, isQueuedWrite);
    await this.loadCategory('migrations', this.migrations, isMigration);
    await this.loadCategory('scope-aliases', this.aliases, isScopeAlias);
    await this.loadCategory('transactions', this.transactions, isTransaction);
    this.initialized = true;
    await this.pruneAuditMap('write-audit', this.writeAudits, (record) => record.at);
    await this.pruneAuditMap('management-audit', this.managementAudits, (record) => record.at);
    await this.pruneAuditMap('resource-audit', this.resourceAudits, (record) => record.at);
    if (this.recovery.size > this.maxRecoveryRecords) {
      throw new Error(`Memory v3 recovery queue exceeds its hard limit (${this.recovery.size}/${this.maxRecoveryRecords}).`);
    }
  }

  async snapshot(): Promise<MemoryV3LedgerSnapshot> {
    await this.ensureInitialized();
    return {
      writeAudit: sorted(this.writeAudits.values(), (record) => record.at),
      managementAudit: sorted(this.managementAudits.values(), (record) => record.at),
      resourceManagementAudit: sorted(this.resourceAudits.values(), (record) => record.at),
      recoveryQueue: sorted(this.recovery.values(), (record) => record.queuedAt),
      migrations: Object.fromEntries([...this.migrations.entries()].map(([id, record]) => [id, structuredClone(record)])),
    };
  }

  appendWriteAudit(record: MemoryWriteAuditRecord): Promise<void> {
    return this.appendAudit('write-audit', this.writeAudits, record, (value) => value.at);
  }

  appendManagementAudit(record: MemoryManagementAuditRecord): Promise<void> {
    return this.appendAudit('management-audit', this.managementAudits, record, (value) => value.at);
  }

  appendResourceAudit(record: MemoryResourceManagementAuditRecord): Promise<void> {
    return this.appendAudit('resource-audit', this.resourceAudits, record, (value) => value.at);
  }

  async materializeEventAudits(payload: Record<string, unknown>): Promise<void> {
    const writeAudit = payload.repositoryWriteAudit;
    if (isWriteAudit(writeAudit)) await this.appendWriteAudit(writeAudit);
    const managementAudit = payload.repositoryManagementAudit;
    if (isManagementAudit(managementAudit)) await this.appendManagementAudit(managementAudit);
  }

  async listResourceAudits(resourceId?: string, limit = 100): Promise<MemoryResourceManagementAuditRecord[]> {
    await this.ensureInitialized();
    return sorted(this.resourceAudits.values(), (record) => record.at, true)
      .filter((record) => !resourceId || record.resourceId === resourceId)
      .slice(0, Math.max(0, limit));
  }

  async enqueue(intent: MemoryWriteIntent, error: string, attempts = 0): Promise<QueuedMemoryWrite> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      if (this.recovery.size >= this.maxRecoveryRecords) {
        throw new Error(`Memory v3 recovery queue limit exceeded (${this.maxRecoveryRecords}).`);
      }
      const record: QueuedMemoryWrite = {
        id: randomUUID(),
        intent: structuredClone(intent),
        error,
        queuedAt: new Date().toISOString(),
        attempts,
      };
      await this.writeRecord('recovery', record.id, record);
      this.recovery.set(record.id, record);
      return structuredClone(record);
    });
  }

  async listRecovery(limit = this.maxRecoveryRecords): Promise<QueuedMemoryWrite[]> {
    await this.ensureInitialized();
    return sorted(this.recovery.values(), (record) => record.queuedAt).slice(0, Math.max(0, limit));
  }

  async updateRecovery(record: QueuedMemoryWrite): Promise<void> {
    await this.ensureInitialized();
    await this.exclusive(async () => {
      if (!this.recovery.has(record.id)) throw new Error(`Memory v3 recovery record not found: ${record.id}`);
      await this.writeRecord('recovery', record.id, record);
      this.recovery.set(record.id, structuredClone(record));
    });
  }

  async removeRecovery(id: string): Promise<boolean> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      if (!this.recovery.delete(id)) return false;
      await unlink(this.pathFor('recovery', id)).catch((error) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      });
      return true;
    });
  }

  async getMigration(id: string): Promise<MemoryMigrationRecord | undefined> {
    await this.ensureInitialized();
    const record = this.migrations.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async markMigration(record: MemoryMigrationRecord): Promise<void> {
    await this.ensureInitialized();
    await this.exclusive(async () => {
      await this.writeRecord('migrations', record.id, record);
      this.migrations.set(record.id, structuredClone(record));
    });
  }

  async ensureScopeAlias(scope: Exclude<MemoryScope, 'global'>, publicKey: string): Promise<MemoryV3ScopeAlias> {
    await this.ensureInitialized();
    const existing = this.findAlias(scope, publicKey);
    if (existing) return structuredClone(existing);
    return this.exclusive(async () => {
      const concurrent = this.findAlias(scope, publicKey);
      if (concurrent) return structuredClone(concurrent);
      const alias: MemoryV3ScopeAlias = {
        version: 1,
        id: scopeAliasId(scope, publicKey),
        scope,
        storageKey: publicKey,
        currentKey: publicKey,
        updatedAt: new Date().toISOString(),
      };
      await this.writeRecord('scope-aliases', alias.id, alias);
      this.aliases.set(alias.id, alias);
      return structuredClone(alias);
    });
  }

  async storageScopeKey(scope: MemoryScope, publicKey: string | undefined): Promise<string | undefined> {
    if (scope === 'global') return undefined;
    if (!publicKey) throw new Error(`Memory scope "${scope}" requires scopeKey.`);
    return (await this.ensureScopeAlias(scope, publicKey)).storageKey;
  }

  publicScopeKey(scope: MemoryScope, storageKey: string | undefined): string | undefined {
    if (scope === 'global' || !storageKey) return undefined;
    return this.findAlias(scope, storageKey)?.currentKey ?? storageKey;
  }

  async rebindScope(fromKey: string, toKey: string): Promise<number> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      const matches = [...this.aliases.values()].filter((alias) => alias.currentKey === fromKey);
      for (const alias of matches) {
        const updated = { ...alias, currentKey: toKey, updatedAt: new Date().toISOString() };
        await this.writeRecord('scope-aliases', alias.id, updated);
        this.aliases.set(alias.id, updated);
      }
      return matches.length;
    });
  }

  async rebindQueuedIntents(fromKey: string, toKey: string): Promise<number> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      let changed = 0;
      for (const record of this.recovery.values()) {
        if (record.intent.scopeKey !== fromKey) continue;
        const updated = { ...record, intent: { ...record.intent, scopeKey: toKey } };
        await this.writeRecord('recovery', record.id, updated);
        this.recovery.set(record.id, updated);
        changed += 1;
      }
      return changed;
    });
  }

  async captureTransaction(
    idempotencyKey: string,
    kind: MemoryV3RepositoryTransaction['kind'],
    payload: Record<string, unknown>,
  ): Promise<MemoryV3RepositoryTransaction> {
    await this.ensureInitialized();
    const prior = [...this.transactions.values()].find((record) => record.idempotencyKey === idempotencyKey);
    if (prior) return structuredClone(prior);
    return this.exclusive(async () => {
      const concurrent = [...this.transactions.values()].find((record) => record.idempotencyKey === idempotencyKey);
      if (concurrent) return structuredClone(concurrent);
      const timestamp = new Date().toISOString();
      const record: MemoryV3RepositoryTransaction = {
        version: 1,
        id: randomUUID(),
        idempotencyKey,
        kind,
        payload: structuredClone(payload),
        completedSteps: [],
        state: 'pending',
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.writeRecord('transactions', record.id, record);
      this.transactions.set(record.id, record);
      return structuredClone(record);
    });
  }

  async markTransactionStep(id: string, step: string): Promise<MemoryV3RepositoryTransaction> {
    return this.updateTransaction(id, (record) => ({
      ...record,
      completedSteps: [...new Set([...record.completedSteps, step])],
      state: 'pending',
      updatedAt: new Date().toISOString(),
    }));
  }

  async markTransactionRecovery(id: string, error: string): Promise<MemoryV3RepositoryTransaction> {
    return this.updateTransaction(id, (record) => ({
      ...record,
      state: 'recovery',
      attempts: record.attempts + 1,
      lastError: error,
      updatedAt: new Date().toISOString(),
    }));
  }

  async commitTransaction(id: string): Promise<void> {
    await this.ensureInitialized();
    await this.exclusive(async () => {
      if (!this.transactions.delete(id)) return;
      await unlink(this.pathFor('transactions', id)).catch((error) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      });
    });
  }

  async listOutstandingTransactions(): Promise<MemoryV3RepositoryTransaction[]> {
    await this.ensureInitialized();
    return sorted(this.transactions.values(), (record) => record.createdAt);
  }

  private async appendAudit<T extends { id: string }>(
    category: string,
    target: Map<string, T>,
    record: T,
    timestamp: (record: T) => string,
  ): Promise<void> {
    await this.ensureInitialized();
    await this.exclusive(async () => {
      await this.writeRecord(category, record.id, record);
      target.set(record.id, structuredClone(record));
      await this.pruneAuditMap(category, target, timestamp);
    });
  }

  private async updateTransaction(
    id: string,
    update: (record: MemoryV3RepositoryTransaction) => MemoryV3RepositoryTransaction,
  ): Promise<MemoryV3RepositoryTransaction> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      const current = this.transactions.get(id);
      if (!current) throw new Error(`Memory v3 repository transaction not found: ${id}`);
      const next = update(current);
      await this.writeRecord('transactions', id, next);
      this.transactions.set(id, next);
      return structuredClone(next);
    });
  }

  private findAlias(scope: Exclude<MemoryScope, 'global'>, key: string): MemoryV3ScopeAlias | undefined {
    return [...this.aliases.values()].find((alias) => (
      alias.scope === scope && (alias.currentKey === key || alias.storageKey === key)
    ));
  }

  private async loadCategory<T extends { id: string }>(
    category: string,
    target: Map<string, T>,
    validate: (value: unknown) => value is T,
  ): Promise<void> {
    target.clear();
    const root = join(this.rootDir, category);
    await mkdir(root, { recursive: true });
    for (const path of await collectJsonFiles(root, MAX_SCAN_RECORDS)) {
      try {
        const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
        if (!validate(value)) throw new Error('invalid record shape');
        if (target.has(value.id)) throw new Error(`duplicate record id ${value.id}`);
        target.set(value.id, value);
      } catch (error) {
        this.log?.('warn', `memory-v3: ignored invalid ${category} record ${path}: ${errorMessage(error)}`);
      }
    }
  }

  private async pruneAuditMap<T extends { id: string }>(
    category: string,
    target: Map<string, T>,
    timestamp: (record: T) => string,
  ): Promise<void> {
    const ordered = [...target.values()].sort((left, right) => timestamp(left).localeCompare(timestamp(right)));
    const remove = ordered.slice(0, Math.max(0, ordered.length - this.maxAuditRecords));
    for (const record of remove) {
      target.delete(record.id);
      await unlink(this.pathFor(category, record.id)).catch((error) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      });
    }
  }

  private writeRecord(category: string, id: string, value: unknown): Promise<void> {
    return durableAtomicWriteJson(this.pathFor(category, id), value);
  }

  private pathFor(category: string, id: string): string {
    const hash = createHash('sha256').update(id, 'utf8').digest('hex');
    return join(this.rootDir, category, hash.slice(0, 2), `${hash}.json`);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(operation, operation);
    this.mutationChain = run.then(() => undefined, () => undefined);
    return run;
  }
}

async function collectJsonFiles(root: string, maximum: number): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path);
      if (files.length > maximum) throw new Error(`Memory v3 repository ledger exceeds scan limit ${maximum}.`);
    }
  }
  return files.sort();
}

function sorted<T>(values: Iterable<T>, timestamp: (record: T) => string, descending = false): T[] {
  const direction = descending ? -1 : 1;
  return [...values]
    .sort((left, right) => timestamp(left).localeCompare(timestamp(right)) * direction)
    .map((record) => structuredClone(record));
}

function scopeAliasId(scope: string, storageKey: string): string {
  return `scope-alias:${scope}:${createHash('sha256').update(storageKey, 'utf8').digest('hex')}`;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function isWriteAudit(value: unknown): value is MemoryWriteAuditRecord {
  return isObjectWithId(value) && typeof value.at === 'string' && typeof value.decision === 'string';
}

function isManagementAudit(value: unknown): value is MemoryManagementAuditRecord {
  return isObjectWithId(value) && typeof value.at === 'string' && typeof value.action === 'string';
}

function isResourceAudit(value: unknown): value is MemoryResourceManagementAuditRecord {
  return isObjectWithId(value) && typeof value.at === 'string' && typeof value.resourceId === 'string';
}

function isQueuedWrite(value: unknown): value is QueuedMemoryWrite {
  return isObjectWithId(value) && typeof value.queuedAt === 'string' && typeof value.attempts === 'number'
    && typeof value.intent === 'object' && value.intent !== null;
}

function isMigration(value: unknown): value is MemoryMigrationRecord {
  return isObjectWithId(value) && typeof value.completedAt === 'string';
}

function isScopeAlias(value: unknown): value is MemoryV3ScopeAlias {
  return isObjectWithId(value) && value.version === 1 && typeof value.scope === 'string'
    && typeof value.storageKey === 'string' && typeof value.currentKey === 'string';
}

function isTransaction(value: unknown): value is MemoryV3RepositoryTransaction {
  return isObjectWithId(value) && value.version === 1 && typeof value.idempotencyKey === 'string'
    && Array.isArray(value.completedSteps) && typeof value.state === 'string';
}

function isObjectWithId(value: unknown): value is Record<string, unknown> & { id: string } {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
