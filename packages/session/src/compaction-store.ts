// Persists bounded session summaries and their activation evidence with atomic recovery.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AtomicActivationLevelTracker,
  applyAtomicActivationObservation,
  atomicActivationSignalsFromEvidence,
  computeAtomicActivation,
  type AtomicActivationEvidence,
  type AtomicActivationLevelCounts,
  type AtomicActivationObservation,
  type CompactionSummary,
  type CompactionSummaryV2,
  type SessionId,
} from '@littlesheep/types';
import { atomicWriteText } from './atomic-file.js';
import {
  COMPACTION_TRANSACTION_VERSION,
  LEGACY_COMPACTION_TRANSACTION_VERSION,
  SESSION_SUMMARY_ACTIVATION_VERSION,
  isActivationRecord,
  isCompactionSummaryV2,
  parsePendingTransaction,
  type CompactionCommitPrecondition,
  type CompactionMemoryCandidateOutcome,
  type CompactionMemoryProposal,
  type PendingCompactionTransaction,
  type SessionSummaryActivationRecord,
} from './compaction-store-codec.js';

const MAX_PENDING_COMPACTIONS = 16;
const MAX_ACTIVATION_RECORDS = 10_000;

export class SessionCompactionStore {
  private readonly activationWrites = new Map<string, Promise<AtomicActivationEvidence>>();
  private readonly activationLevels = new AtomicActivationLevelTracker(MAX_ACTIVATION_RECORDS);

  constructor(private readonly sessionsDir: string) {}

  hasPending(sessionId: SessionId): boolean {
    return existsSync(this.pendingDir(sessionId));
  }

  async commit(
    sessionId: SessionId,
    summary: CompactionSummaryV2,
    preconditionOrApply: CompactionCommitPrecondition | ((summary: CompactionSummaryV2) => Promise<void>),
    applyTransaction?: (transaction: PendingCompactionTransaction) => Promise<void>,
    memoryProposal?: CompactionMemoryProposal,
  ): Promise<void> {
    const legacyApply = typeof preconditionOrApply === 'function' ? preconditionOrApply : undefined;
    await this.ensureLayout(sessionId);
    const transaction: PendingCompactionTransaction = legacyApply
      ? {
          // Callers that still use the pre-CAS API keep the version-1 protocol: no source-prefix precondition.
          version: LEGACY_COMPACTION_TRANSACTION_VERSION,
          sessionId: String(sessionId),
          summary,
          createdAt: new Date().toISOString(),
        }
      : {
          version: COMPACTION_TRANSACTION_VERSION,
          sessionId: String(sessionId),
          summary,
          precondition: preconditionOrApply as CompactionCommitPrecondition,
          ...(memoryProposal ? { memoryProposal } : {}),
          createdAt: new Date().toISOString(),
        };
    const pendingPath = this.pendingPath(sessionId, summary.id);
    await atomicWriteText(pendingPath, JSON.stringify(transaction, null, 2));
    try {
      await this.persistProjection(sessionId, summary);
      if (legacyApply) await legacyApply(summary);
      else await applyTransaction!(transaction);
      await this.pruneActivationRecords(sessionId, summary.id);
      if (transaction.version === COMPACTION_TRANSACTION_VERSION && transaction.memoryProposal) {
        transaction.summaryCommittedAt = new Date().toISOString();
        await atomicWriteText(pendingPath, JSON.stringify(transaction, null, 2));
      } else {
        await unlink(pendingPath).catch((error: unknown) => {
          if (errorCode(error) !== 'ENOENT') throw error;
        });
      }
    } catch (error) {
      // Keep transient failures pending so recovery can retry them; only isolate terminal conflicts.
      if (isTerminalCompactionConflict(error)) {
        await this.quarantinePending(sessionId, pendingPath, summary.id).catch(() => undefined);
      }
      throw error;
    }
    await rmdir(this.pendingDir(sessionId)).catch(() => undefined);
  }

  async recover(
    sessionId: SessionId,
    applyMetadata: (transaction: PendingCompactionTransaction) => Promise<void>,
  ): Promise<number> {
    if (!this.hasPending(sessionId)) return 0;
    const names = (await readdir(this.pendingDir(sessionId)))
      .filter((name) => name.endsWith('.pending.json'))
      .sort()
      .slice(0, MAX_PENDING_COMPACTIONS);
    let recovered = 0;
    for (const name of names) {
      const path = join(this.pendingDir(sessionId), name);
      const transaction = parsePendingTransaction(await readFile(path, 'utf8'), String(sessionId));
      try {
        await this.persistProjection(sessionId, transaction.summary);
        await applyMetadata(transaction);
        if (transaction.version === 2 && transaction.memoryProposal) {
          transaction.summaryCommittedAt ??= new Date().toISOString();
          await atomicWriteText(path, JSON.stringify(transaction, null, 2));
        } else {
          await unlink(path);
        }
        recovered += 1;
      } catch {
        await this.quarantinePending(sessionId, path, transaction.summary.id);
      }
    }
    await rmdir(this.pendingDir(sessionId)).catch(() => undefined);
    return recovered;
  }

  async listPending(sessionId: SessionId): Promise<PendingCompactionTransaction[]> {
    if (!this.hasPending(sessionId)) return [];
    const names = (await readdir(this.pendingDir(sessionId)))
      .filter((name) => name.endsWith('.pending.json'))
      .sort()
      .slice(0, MAX_PENDING_COMPACTIONS);
    const transactions: PendingCompactionTransaction[] = [];
    for (const name of names) {
      transactions.push(parsePendingTransaction(
        await readFile(join(this.pendingDir(sessionId), name), 'utf8'),
        String(sessionId),
      ));
    }
    return transactions;
  }

  async recordCandidateOutcome(
    sessionId: SessionId,
    summaryId: string,
    outcome: CompactionMemoryCandidateOutcome,
  ): Promise<void> {
    const path = this.pendingPath(sessionId, summaryId);
    if (!existsSync(path)) return;
    const transaction = parsePendingTransaction(await readFile(path, 'utf8'), String(sessionId));
    if (transaction.version !== 2 || !transaction.memoryProposal) return;
    const candidateIds = new Set(transaction.memoryProposal.candidates.map((candidate) => candidate.id));
    if (!candidateIds.has(outcome.candidateId)) throw new Error(`Unknown compaction candidate: ${outcome.candidateId}`);
    const outcomes = transaction.memoryProposal.outcomes.filter((entry) => entry.candidateId !== outcome.candidateId);
    outcomes.push(structuredClone(outcome));
    transaction.memoryProposal.outcomes = outcomes;
    await atomicWriteText(path, JSON.stringify(transaction, null, 2));
  }

  async completeMemoryProposal(sessionId: SessionId, summaryId: string): Promise<void> {
    const path = this.pendingPath(sessionId, summaryId);
    if (!existsSync(path)) return;
    const transaction = parsePendingTransaction(await readFile(path, 'utf8'), String(sessionId));
    if (transaction.version !== 2 || !transaction.memoryProposal) return;
    const candidateIds = new Set(transaction.memoryProposal.candidates.map((candidate) => candidate.id));
    const outcomeIds = new Set(transaction.memoryProposal.outcomes.map((outcome) => outcome.candidateId));
    if ([...candidateIds].some((id) => !outcomeIds.has(id))) {
      throw new Error(`Compaction memory proposal ${summaryId} still has pending candidates.`);
    }
    await unlink(path);
    await rmdir(this.pendingDir(sessionId)).catch(() => undefined);
  }

  async load(sessionId: SessionId, summaryId: string): Promise<CompactionSummary | undefined> {
    const path = this.projectionPath(sessionId, summaryId);
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return isCompactionSummaryV2(value) ? structuredClone(value) : undefined;
  }

  async recordActivation(
    sessionId: SessionId,
    summaryId: string,
    observation: AtomicActivationObservation,
  ): Promise<AtomicActivationEvidence> {
    if (!await this.load(sessionId, summaryId)) {
      throw new Error(`Session summary activation target is unavailable: ${summaryId}`);
    }
    const key = `${sessionId}\0${summaryId}`;
    const previous = this.activationWrites.get(key) ?? Promise.resolve(undefined);
    const next = previous
      .catch(() => undefined)
      .then(() => this.writeActivation(sessionId, summaryId, observation));
    this.activationWrites.set(key, next);
    try {
      return await next;
    } finally {
      if (this.activationWrites.get(key) === next) this.activationWrites.delete(key);
    }
  }

  async loadActivation(sessionId: SessionId, summaryId: string): Promise<AtomicActivationEvidence | undefined> {
    const record = await this.readActivationRecord(this.activationPath(sessionId, summaryId));
    return record?.evidence;
  }

  async activationOverview(now = new Date().toISOString()): Promise<AtomicActivationLevelCounts> {
    const root = join(this.sessionsDir, '.compactions');
    if (!existsSync(root)) return this.activationLevels.project([]);
    const sessionDirs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    const entries: Array<{ id: string; score: number }> = [];
    let inspected = 0;
    for (const sessionDir of sessionDirs) {
      if (inspected >= MAX_ACTIVATION_RECORDS) break;
      const activationDir = join(root, sessionDir.name, 'activation');
      if (!existsSync(activationDir)) continue;
      const names = (await readdir(activationDir))
        .filter((name) => name.endsWith('.activation.json'))
        .sort();
      for (const name of names) {
        if (inspected >= MAX_ACTIVATION_RECORDS) break;
        inspected += 1;
        const record = await this.readActivationRecord(join(activationDir, name)).catch(() => undefined);
        if (!record) continue;
        const snapshot = computeAtomicActivation(
          atomicActivationSignalsFromEvidence(record.evidence, record.createdAt),
          now,
        );
        entries.push({ id: `${sessionDir.name}/${name}`, score: snapshot.score });
      }
    }
    return this.activationLevels.project(entries);
  }

  async removeSession(sessionId: SessionId): Promise<void> {
    await rm(this.compactionDir(sessionId), { recursive: true, force: true });
  }

  private async persistProjection(sessionId: SessionId, summary: CompactionSummaryV2): Promise<void> {
    const path = this.projectionPath(sessionId, summary.id);
    if (existsSync(path)) {
      const existing = JSON.parse(await readFile(path, 'utf8')) as unknown;
      if (!isCompactionSummaryV2(existing) || canonicalHash(existing) !== canonicalHash(summary)) {
        throw new Error(`Session compaction projection conflicts with existing record: ${summary.id}`);
      }
      return;
    }
    await atomicWriteText(path, JSON.stringify(summary, null, 2));
  }

  private async writeActivation(
    sessionId: SessionId,
    summaryId: string,
    observation: AtomicActivationObservation,
  ): Promise<AtomicActivationEvidence> {
    const path = this.activationPath(sessionId, summaryId);
    const current = await this.readActivationRecord(path);
    const evidence = applyAtomicActivationObservation(current?.evidence, observation);
    const record: SessionSummaryActivationRecord = {
      version: SESSION_SUMMARY_ACTIVATION_VERSION,
      namespace: 'session-summary',
      sessionId: String(sessionId),
      summaryId,
      createdAt: current?.createdAt ?? observation.observedAt,
      updatedAt: observation.observedAt,
      evidence,
    };
    await mkdir(this.activationDir(sessionId), { recursive: true });
    await atomicWriteText(path, JSON.stringify(record, null, 2));
    return structuredClone(evidence);
  }

  private async readActivationRecord(path: string): Promise<SessionSummaryActivationRecord | undefined> {
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isActivationRecord(value)) throw new Error(`Invalid session summary activation record: ${path}`);
    return value;
  }

  private async pruneActivationRecords(sessionId: SessionId, activeSummaryId: string): Promise<void> {
    const directory = this.activationDir(sessionId);
    if (!existsSync(directory)) return;
    const keep = `${digest(activeSummaryId)}.activation.json`;
    const names = (await readdir(directory)).filter((name) => name.endsWith('.activation.json'));
    await Promise.all(names.filter((name) => name !== keep).map((name) => unlink(join(directory, name))));
  }

  private async ensureLayout(sessionId: SessionId): Promise<void> {
    await Promise.all([
      mkdir(this.projectionDir(sessionId), { recursive: true }),
      mkdir(this.pendingDir(sessionId), { recursive: true }),
    ]);
  }

  private async quarantinePending(sessionId: SessionId, path: string, summaryId: string): Promise<void> {
    if (!existsSync(path)) return;
    const directory = this.failedDir(sessionId);
    await mkdir(directory, { recursive: true });
    const target = join(directory, `${digest(summaryId)}.${Date.now()}.failed.json`);
    await rename(path, target);
  }

  private projectionDir(sessionId: SessionId): string {
    return join(this.compactionDir(sessionId), 'records');
  }

  private pendingDir(sessionId: SessionId): string {
    return join(this.compactionDir(sessionId), 'pending');
  }

  private activationDir(sessionId: SessionId): string {
    return join(this.compactionDir(sessionId), 'activation');
  }

  private failedDir(sessionId: SessionId): string {
    return join(this.compactionDir(sessionId), 'failed');
  }

  private compactionDir(sessionId: SessionId): string {
    return join(this.sessionsDir, '.compactions', digest(String(sessionId)));
  }

  private projectionPath(sessionId: SessionId, summaryId: string): string {
    return join(this.projectionDir(sessionId), `${digest(summaryId)}.compaction.json`);
  }

  private pendingPath(sessionId: SessionId, summaryId: string): string {
    return join(this.pendingDir(sessionId), `${digest(summaryId)}.pending.json`);
  }

  private activationPath(sessionId: SessionId, summaryId: string): string {
    return join(this.activationDir(sessionId), `${digest(summaryId)}.activation.json`);
  }
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/** A conflict with the current session state is terminal; the pending record is isolated, not retried. */
function isTerminalCompactionConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'StaleCompactionError'
    || error.message.startsWith('Session compaction projection conflicts with existing record');
}
