// Durable decisions for immutable RunCheckpoint records.
//
// A checkpoint body is never edited. Resume/abandon decisions live in this
// separate, bounded store so a user action is auditable and a failed resume
// can be distinguished from an untouched checkpoint.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunCheckpointDisposition } from '@littlesheep/types'
import { RUN_CHECKPOINT_DISPOSITION_VERSION } from '@littlesheep/types'
import { acquireLock } from '@littlesheep/session'

export const DEFAULT_RUN_CHECKPOINT_DISPOSITION_MAX_RECORDS = 512 as const
export const MAX_RUN_CHECKPOINT_DISPOSITION_MAX_RECORDS = 2_048 as const
const MAX_REASON_LENGTH = 4_096
const MAX_HISTORY = 8
const MAX_FILE_BYTES = 128 * 1024
const STALE_TEMP_FILE_AGE_MS = 60 * 60 * 1_000
const STORE_LOCK_TIMEOUT_MS = 60_000

export interface RunCheckpointDispositionStoreOptions {
  rootDir: string
  maxRecords?: number
  now?: () => Date
}

export type RunCheckpointDispositionOutcome =
  | { kind: 'written'; disposition: RunCheckpointDisposition }
  | { kind: 'duplicate'; disposition: RunCheckpointDisposition }
  | { kind: 'conflict'; disposition: RunCheckpointDisposition; message: string }

export interface RunCheckpointAnswerClaimIdentity {
  requestId: string
  answerMessageId: string
  requestKey: string
  continuationDisposition?: import('@littlesheep/types').RunCheckpointContinuationDisposition
}

export interface RunCheckpointResumeClaimOptions {
  /** Only an explicit recovery selection may reactivate a previously deferred task. */
  allowDeferred?: boolean
}

export interface RunCheckpointDispositionListOptions {
  statuses?: RunCheckpointDisposition['status'][]
  resumeRunId?: string
  requestKey?: string
  limit?: number
}

export class RunCheckpointDispositionStore {
  private readonly rootDir: string
  private readonly maxRecords: number
  private readonly now: () => Date
  private writeTail: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(options: RunCheckpointDispositionStoreOptions) {
    const root = options.rootDir.trim()
    if (!root) throw new Error('Run checkpoint disposition rootDir must be non-empty.')
    this.rootDir = root
    this.maxRecords = boundedInteger(
      options.maxRecords,
      DEFAULT_RUN_CHECKPOINT_DISPOSITION_MAX_RECORDS,
      1,
      MAX_RUN_CHECKPOINT_DISPOSITION_MAX_RECORDS,
    )
    this.now = options.now ?? (() => new Date())
  }

  async initialize(): Promise<void> {
    this.ensureUsable()
    await mkdir(this.rootDir, { recursive: true })
    const entries = await readdir(this.rootDir, { withFileTypes: true }).catch(() => [])
    const now = this.now().getTime()
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue
      const file = join(this.rootDir, entry.name)
      const details = await stat(file).catch(() => undefined)
      if (details && now - details.mtimeMs > STALE_TEMP_FILE_AGE_MS) await rm(file, { force: true }).catch(() => undefined)
    }
  }

  async read(checkpointId: string): Promise<RunCheckpointDisposition | null> {
    this.ensureUsable()
    const id = normalizeId(checkpointId)
    try {
      const parsed = JSON.parse(await readFile(this.filePath(id), 'utf8')) as unknown
      return validateDisposition(parsed, id)
    } catch {
      return null
    }
  }

  /** Bounded newest-first scan used by startup recovery and checkpoint retention. */
  async list(options: RunCheckpointDispositionListOptions = {}): Promise<RunCheckpointDisposition[]> {
    this.ensureUsable()
    const statuses = options.statuses ? new Set(options.statuses) : undefined
    const resumeRunId = options.resumeRunId === undefined ? undefined : normalizeId(options.resumeRunId)
    const requestKey = options.requestKey === undefined ? undefined : normalizeId(options.requestKey)
    const limit = boundedInteger(options.limit, this.maxRecords, 1, this.maxRecords)
    const entries = await readdir(this.rootDir, { withFileTypes: true }).catch(() => [])
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .slice(0, this.maxRecords)
      .map(async (entry) => {
        try {
          const parsed = JSON.parse(await readFile(join(this.rootDir, entry.name), 'utf8')) as unknown
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
          const checkpointId = normalizeId((parsed as Record<string, unknown>).checkpointId)
          return validateDisposition(parsed, checkpointId)
        } catch {
          return undefined
        }
      }))
    return records
      .filter((record): record is RunCheckpointDisposition => Boolean(record))
      .filter((record) => !statuses || statuses.has(record.status))
      .filter((record) => resumeRunId === undefined || record.resumeRunId === resumeRunId)
      .filter((record) => requestKey === undefined || record.requestKey === requestKey)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, limit)
      .map(clone)
  }

  async claimResume(
    checkpointId: string,
    reason: string,
    resumeRunId: string = randomUUID(),
    identity?: RunCheckpointAnswerClaimIdentity,
    options: RunCheckpointResumeClaimOptions = {},
  ): Promise<RunCheckpointDispositionOutcome> {
    this.ensureUsable()
    const id = normalizeId(checkpointId)
    const normalizedReason = boundedReason(reason)
    const normalizedRunId = normalizeId(resumeRunId)
    const normalizedIdentity = identity ? validateClaimIdentity(identity) : undefined
    return this.enqueueWrite(async () => {
      const existing = await this.readUnsafe(id)
      if (existing) {
        if (existing.status === 'resuming') {
          if (!normalizedIdentity || sameClaimIdentity(existing, normalizedIdentity)) {
            return { kind: 'duplicate', disposition: clone(existing) }
          }
          return {
            kind: 'conflict',
            disposition: clone(existing),
            message: 'checkpoint has an active resume lease for a different conversation turn',
          }
        }
        if (existing.status === 'interrupted') {
          if (existing.requestKey
            && (!normalizedIdentity || !sameClaimIdentity(existing, normalizedIdentity))) {
            return {
              kind: 'conflict',
              disposition: clone(existing),
              message: 'interrupted checkpoint belongs to a different conversation turn',
            }
          }
          return this.update(existing, {
            status: 'resuming',
            reason: normalizedReason,
            resumeRunId: normalizedRunId,
            ...normalizedIdentity,
          })
        }
        if (existing.status === 'deferred') {
          if (!options.allowDeferred) {
            return {
              kind: 'conflict',
              disposition: clone(existing),
              message: 'checkpoint is deferred and requires an explicit recovery selection',
            }
          }
          return this.update(existing, {
            status: 'resuming',
            reason: normalizedReason,
            resumeRunId: normalizedRunId,
            ...normalizedIdentity,
          })
        }
        return { kind: 'conflict', disposition: clone(existing), message: `checkpoint is already ${existing.status}` }
      }
      const now = this.now().toISOString()
      const disposition: RunCheckpointDisposition = {
        version: RUN_CHECKPOINT_DISPOSITION_VERSION,
        checkpointId: id,
        status: 'resuming',
        decidedAt: now,
        updatedAt: now,
        reason: normalizedReason,
        resumeRunId: normalizedRunId,
        ...normalizedIdentity,
        history: [{
          status: 'resuming',
          at: now,
          reason: normalizedReason,
          resumeRunId: normalizedRunId,
          ...normalizedIdentity,
        }],
      }
      await this.writeAtomic(disposition)
      await this.pruneUnsafe()
      return { kind: 'written', disposition: clone(disposition) }
    })
  }

  async completeResume(
    checkpointId: string,
    resumeRunId: string,
    resultStatus: 'ok' | 'error' | 'aborted',
    reason: string,
    nextCheckpointId?: string,
  ): Promise<RunCheckpointDispositionOutcome> {
    return this.transition(checkpointId, resumeRunId, {
      status: 'resumed',
      resultStatus,
      reason,
      ...(nextCheckpointId ? { nextCheckpointId } : {}),
    })
  }

  /** Seal a lease after a durable session completion receipt proves the run finished. */
  async reconcileCompletedResume(
    checkpointId: string,
    resumeRunId: string,
    resultStatus: 'ok' | 'error' | 'aborted',
    reason: string,
    nextCheckpointId?: string,
  ): Promise<RunCheckpointDispositionOutcome> {
    this.ensureUsable()
    const id = normalizeId(checkpointId)
    const runId = normalizeId(resumeRunId)
    const normalizedReason = boundedReason(reason)
    return this.enqueueWrite(async () => {
      const existing = await this.readUnsafe(id)
      if (!existing) {
        return { kind: 'conflict', disposition: emptyConflict(id), message: 'resume disposition is missing' }
      }
      if (existing.status === 'resumed') return { kind: 'duplicate', disposition: clone(existing) }
      if (
        (existing.status !== 'resuming' && existing.status !== 'interrupted')
        || existing.resumeRunId !== runId
      ) {
        return {
          kind: 'conflict',
          disposition: clone(existing),
          message: 'completion receipt does not belong to this resume lease',
        }
      }
      return this.update(existing, {
        status: 'resumed',
        resultStatus,
        reason: normalizedReason,
        resumeRunId: runId,
        ...(nextCheckpointId ? { nextCheckpointId: normalizeId(nextCheckpointId) } : {}),
      })
    })
  }

  /** Seal an intermediate checkpoint after its original source run completed successfully. */
  async completeSourceRun(
    checkpointId: string,
    reason: string,
  ): Promise<RunCheckpointDispositionOutcome> {
    this.ensureUsable()
    const id = normalizeId(checkpointId)
    const normalizedReason = boundedReason(reason)
    return this.enqueueWrite(async () => {
      const existing = await this.readUnsafe(id)
      if (existing?.status === 'completed') return { kind: 'duplicate', disposition: clone(existing) }
      if (existing?.status === 'interrupted') {
        return this.update(existing, {
          status: 'completed',
          reason: normalizedReason,
          resultStatus: 'ok',
        })
      }
      if (existing) {
        return {
          kind: 'conflict',
          disposition: clone(existing),
          message: `checkpoint is already ${existing.status}`,
        }
      }
      const now = this.now().toISOString()
      const disposition: RunCheckpointDisposition = {
        version: RUN_CHECKPOINT_DISPOSITION_VERSION,
        checkpointId: id,
        status: 'completed',
        decidedAt: now,
        updatedAt: now,
        reason: normalizedReason,
        resultStatus: 'ok',
        history: [{
          status: 'completed',
          at: now,
          reason: normalizedReason,
          resultStatus: 'ok',
        }],
      }
      await this.writeAtomic(disposition)
      await this.pruneUnsafe()
      return { kind: 'written', disposition: clone(disposition) }
    })
  }

  /** Release a resume lease that belonged to a process which no longer exists. */
  async interruptResume(
    checkpointId: string,
    resumeRunId: string,
    reason: string,
    nextCheckpointId?: string,
  ): Promise<RunCheckpointDispositionOutcome> {
    this.ensureUsable()
    const id = normalizeId(checkpointId)
    const runId = normalizeId(resumeRunId)
    const normalizedReason = boundedReason(reason)
    return this.enqueueWrite(async () => {
      const existing = await this.readUnsafe(id)
      if (!existing) return { kind: 'conflict', disposition: emptyConflict(id), message: 'resume disposition is missing' }
      if (existing.status === 'interrupted') return { kind: 'duplicate', disposition: clone(existing) }
      if (existing.status !== 'resuming' || existing.resumeRunId !== runId) {
        return { kind: 'conflict', disposition: clone(existing), message: 'resume lease does not belong to this run' }
      }
      return this.update(existing, {
        status: 'interrupted',
        reason: normalizedReason,
        resumeRunId: runId,
        ...(nextCheckpointId ? { nextCheckpointId: normalizeId(nextCheckpointId) } : {}),
      })
    })
  }

  async abandon(
    checkpointId: string,
    reason: string,
    identity?: RunCheckpointAnswerClaimIdentity,
  ): Promise<RunCheckpointDispositionOutcome> {
    this.ensureUsable()
    const id = normalizeId(checkpointId)
    const normalizedReason = boundedReason(reason)
    const normalizedIdentity = identity ? validateClaimIdentity(identity) : undefined
    return this.enqueueWrite(async () => {
      const existing = await this.readUnsafe(id)
      if (existing?.status === 'abandoned') {
        if (!normalizedIdentity || sameClaimIdentity(existing, normalizedIdentity)) {
          return { kind: 'duplicate', disposition: clone(existing) }
        }
        return { kind: 'conflict', disposition: clone(existing), message: 'checkpoint was abandoned by another conversation turn' }
      }
      if (existing?.status === 'resumed') return { kind: 'conflict', disposition: clone(existing), message: 'checkpoint has already been resumed' }
      if (existing?.status === 'completed') return { kind: 'conflict', disposition: clone(existing), message: 'checkpoint source run has already completed' }
      if (!existing) {
        const now = this.now().toISOString()
        const disposition: RunCheckpointDisposition = {
          version: RUN_CHECKPOINT_DISPOSITION_VERSION,
          checkpointId: id,
          status: 'abandoned',
          decidedAt: now,
          updatedAt: now,
          reason: normalizedReason,
          ...normalizedIdentity,
          history: [{ status: 'abandoned', at: now, reason: normalizedReason, ...normalizedIdentity }],
        }
        await this.writeAtomic(disposition)
        await this.pruneUnsafe()
        return { kind: 'written', disposition: clone(disposition) }
      }
      return this.update(existing, { status: 'abandoned', reason: normalizedReason, ...normalizedIdentity })
    })
  }

  /** Remove a waiting task from automatic binding while keeping explicit recovery available. */
  async defer(
    checkpointId: string,
    reason: string,
    identity?: RunCheckpointAnswerClaimIdentity,
  ): Promise<RunCheckpointDispositionOutcome> {
    this.ensureUsable()
    const id = normalizeId(checkpointId)
    const normalizedReason = boundedReason(reason)
    const normalizedIdentity = identity ? validateClaimIdentity(identity) : undefined
    return this.enqueueWrite(async () => {
      const existing = await this.readUnsafe(id)
      if (existing?.status === 'deferred') {
        if (!normalizedIdentity || sameClaimIdentity(existing, normalizedIdentity)) {
          return { kind: 'duplicate', disposition: clone(existing) }
        }
        return { kind: 'conflict', disposition: clone(existing), message: 'checkpoint was deferred by another conversation turn' }
      }
      if (existing?.status === 'resuming' || existing?.status === 'resumed' || existing?.status === 'completed' || existing?.status === 'abandoned') {
        return { kind: 'conflict', disposition: clone(existing), message: `checkpoint is already ${existing.status}` }
      }
      if (existing) return this.update(existing, { status: 'deferred', reason: normalizedReason, ...normalizedIdentity })
      const now = this.now().toISOString()
      const disposition: RunCheckpointDisposition = {
        version: RUN_CHECKPOINT_DISPOSITION_VERSION,
        checkpointId: id,
        status: 'deferred',
        decidedAt: now,
        updatedAt: now,
        reason: normalizedReason,
        ...normalizedIdentity,
        history: [{ status: 'deferred', at: now, reason: normalizedReason, ...normalizedIdentity }],
      }
      await this.writeAtomic(disposition)
      await this.pruneUnsafe()
      return { kind: 'written', disposition: clone(disposition) }
    })
  }

  async prune(): Promise<number> {
    this.ensureUsable()
    return this.enqueueWrite(() => this.pruneUnsafe())
  }

  dispose(): void {
    this.disposed = true
  }

  private async transition(
    checkpointId: string,
    resumeRunId: string,
    transition: {
      status: 'resumed'
      resultStatus: 'ok' | 'error' | 'aborted'
      reason: string
      nextCheckpointId?: string
    },
  ): Promise<RunCheckpointDispositionOutcome> {
    this.ensureUsable()
    const id = normalizeId(checkpointId)
    const runId = normalizeId(resumeRunId)
    return this.enqueueWrite(async () => {
      const existing = await this.readUnsafe(id)
      if (!existing) return { kind: 'conflict', disposition: emptyConflict(id), message: 'resume disposition is missing' }
      if (existing.status === 'resumed') return { kind: 'duplicate', disposition: clone(existing) }
      if (existing.status !== 'resuming' || existing.resumeRunId !== runId) {
        return { kind: 'conflict', disposition: clone(existing), message: 'resume lease does not belong to this run' }
      }
      return this.update(existing, transition)
    })
  }

  private async update(
    existing: RunCheckpointDisposition,
    transition: {
      status: RunCheckpointDisposition['status']
      reason: string
      resumeRunId?: string
      nextCheckpointId?: string
      resultStatus?: 'ok' | 'error' | 'aborted'
      requestId?: string
      answerMessageId?: string
      requestKey?: string
      continuationDisposition?: import('@littlesheep/types').RunCheckpointContinuationDisposition
    },
  ): Promise<RunCheckpointDispositionOutcome> {
    const now = this.now().toISOString()
    const entry = {
      status: transition.status,
      at: now,
      reason: boundedReason(transition.reason),
      ...(transition.resumeRunId ? { resumeRunId: transition.resumeRunId } : existing.resumeRunId ? { resumeRunId: existing.resumeRunId } : {}),
      ...(transition.nextCheckpointId ? { nextCheckpointId: transition.nextCheckpointId } : {}),
      ...(transition.resultStatus ? { resultStatus: transition.resultStatus } : {}),
      ...(transition.requestId ? { requestId: transition.requestId } : existing.requestId ? { requestId: existing.requestId } : {}),
      ...(transition.answerMessageId ? { answerMessageId: transition.answerMessageId } : existing.answerMessageId ? { answerMessageId: existing.answerMessageId } : {}),
      ...(transition.requestKey ? { requestKey: transition.requestKey } : existing.requestKey ? { requestKey: existing.requestKey } : {}),
      ...(transition.continuationDisposition
        ? { continuationDisposition: transition.continuationDisposition }
        : existing.continuationDisposition
          ? { continuationDisposition: existing.continuationDisposition }
          : {}),
    }
    const next: RunCheckpointDisposition = {
      ...existing,
      status: transition.status,
      updatedAt: now,
      reason: entry.reason,
      ...(entry.resumeRunId ? { resumeRunId: entry.resumeRunId } : {}),
      ...(entry.nextCheckpointId ? { nextCheckpointId: entry.nextCheckpointId } : {}),
      ...(entry.resultStatus ? { resultStatus: entry.resultStatus } : {}),
      ...(entry.requestId ? { requestId: entry.requestId } : {}),
      ...(entry.answerMessageId ? { answerMessageId: entry.answerMessageId } : {}),
      ...(entry.requestKey ? { requestKey: entry.requestKey } : {}),
      ...(entry.continuationDisposition ? { continuationDisposition: entry.continuationDisposition } : {}),
      history: [...existing.history, entry].slice(-MAX_HISTORY),
    }
    await this.writeAtomic(next)
    return { kind: 'written', disposition: clone(next) }
  }

  private async readUnsafe(id: string): Promise<RunCheckpointDisposition | null> {
    try {
      return validateDisposition(JSON.parse(await readFile(this.filePath(id), 'utf8')) as unknown, id)
    } catch {
      return null
    }
  }

  private async writeAtomic(disposition: RunCheckpointDisposition): Promise<void> {
    const file = this.filePath(disposition.checkpointId)
    const serialized = JSON.stringify(disposition, null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) throw new Error('checkpoint disposition exceeds its size limit')
    await mkdir(this.rootDir, { recursive: true })
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async pruneUnsafe(): Promise<number> {
    const entries = await readdir(this.rootDir, { withFileTypes: true }).catch(() => [])
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const file = join(this.rootDir, entry.name)
        const details = await stat(file).catch(() => undefined)
        return details ? { file, modifiedAt: details.mtimeMs } : undefined
      }))
    const ordered = files.filter((item): item is { file: string; modifiedAt: number } => Boolean(item))
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
    let removed = 0
    for (const item of ordered.slice(this.maxRecords)) {
      await rm(item.file, { force: true }).then(() => { removed += 1 }).catch(() => undefined)
    }
    return removed
  }

  private filePath(checkpointId: string): string {
    return join(this.rootDir, `${hash(checkpointId)}.json`)
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    this.ensureUsable()
    const current = this.writeTail.catch(() => undefined).then(async () => {
      await mkdir(this.rootDir, { recursive: true })
      const lock = await acquireLock(join(this.rootDir, '.checkpoint-dispositions'), STORE_LOCK_TIMEOUT_MS)
      try {
        return await operation()
      } finally {
        await lock.release()
      }
    })
    this.writeTail = current.then(() => undefined, () => undefined)
    return current
  }

  private ensureUsable(): void {
    if (this.disposed) throw new Error('Run checkpoint disposition store has been disposed.')
  }
}

function validateDisposition(value: unknown, expectedId: string): RunCheckpointDisposition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid disposition')
  const record = value as Record<string, unknown>
  if (record.version !== RUN_CHECKPOINT_DISPOSITION_VERSION || record.checkpointId !== expectedId) throw new Error('invalid disposition version or id')
  if (record.status !== 'resuming' && record.status !== 'interrupted' && record.status !== 'resumed' && record.status !== 'completed' && record.status !== 'abandoned' && record.status !== 'deferred') throw new Error('invalid disposition status')
  const history = Array.isArray(record.history) ? record.history : []
  if (history.length === 0 || history.length > MAX_HISTORY) throw new Error('invalid disposition history')
  return {
    version: RUN_CHECKPOINT_DISPOSITION_VERSION,
    checkpointId: expectedId,
    status: record.status,
    decidedAt: validTime(record.decidedAt),
    updatedAt: validTime(record.updatedAt),
    reason: boundedReason(record.reason),
    ...(record.resumeRunId ? { resumeRunId: normalizeId(record.resumeRunId) } : {}),
    ...(record.requestId ? { requestId: normalizeId(record.requestId) } : {}),
    ...(record.answerMessageId ? { answerMessageId: normalizeId(record.answerMessageId) } : {}),
    ...(record.requestKey ? { requestKey: normalizeId(record.requestKey) } : {}),
    ...(validContinuationDisposition(record.continuationDisposition)
      ? { continuationDisposition: record.continuationDisposition } : {}),
    ...(record.nextCheckpointId ? { nextCheckpointId: normalizeId(record.nextCheckpointId) } : {}),
    ...(record.resultStatus === 'ok' || record.resultStatus === 'error' || record.resultStatus === 'aborted'
      ? { resultStatus: record.resultStatus } : {}),
    history: history.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid disposition history entry')
      const entry = item as Record<string, unknown>
      if (entry.status !== 'resuming' && entry.status !== 'interrupted' && entry.status !== 'resumed' && entry.status !== 'completed' && entry.status !== 'abandoned' && entry.status !== 'deferred') throw new Error('invalid disposition history status')
      return {
        status: entry.status,
        at: validTime(entry.at),
        reason: boundedReason(entry.reason),
        ...(entry.resumeRunId ? { resumeRunId: normalizeId(entry.resumeRunId) } : {}),
        ...(entry.requestId ? { requestId: normalizeId(entry.requestId) } : {}),
        ...(entry.answerMessageId ? { answerMessageId: normalizeId(entry.answerMessageId) } : {}),
        ...(entry.requestKey ? { requestKey: normalizeId(entry.requestKey) } : {}),
        ...(validContinuationDisposition(entry.continuationDisposition)
          ? { continuationDisposition: entry.continuationDisposition } : {}),
        ...(entry.nextCheckpointId ? { nextCheckpointId: normalizeId(entry.nextCheckpointId) } : {}),
        ...(entry.resultStatus === 'ok' || entry.resultStatus === 'error' || entry.resultStatus === 'aborted'
          ? { resultStatus: entry.resultStatus } : {}),
      }
    }),
  }
}

function validateClaimIdentity(identity: RunCheckpointAnswerClaimIdentity): RunCheckpointAnswerClaimIdentity {
  return {
    requestId: normalizeId(identity.requestId),
    answerMessageId: normalizeId(identity.answerMessageId),
    requestKey: normalizeId(identity.requestKey),
    ...(identity.continuationDisposition
      ? { continuationDisposition: validateContinuationDisposition(identity.continuationDisposition) }
      : {}),
  }
}

function sameClaimIdentity(
  disposition: RunCheckpointDisposition,
  identity: RunCheckpointAnswerClaimIdentity,
): boolean {
  return disposition.requestId === identity.requestId
    && disposition.answerMessageId === identity.answerMessageId
    && disposition.requestKey === identity.requestKey
}

function validContinuationDisposition(
  value: unknown,
): value is import('@littlesheep/types').RunCheckpointContinuationDisposition {
  return value === 'answer'
    || value === 'retry'
    || value === 'revise_goal'
    || value === 'cancel'
    || value === 'new_task'
}

function validateContinuationDisposition(
  value: unknown,
): import('@littlesheep/types').RunCheckpointContinuationDisposition {
  if (!validContinuationDisposition(value)) throw new Error('invalid continuation disposition')
  return value
}

function emptyConflict(checkpointId: string): RunCheckpointDisposition {
  const now = new Date(0).toISOString()
  return {
    version: RUN_CHECKPOINT_DISPOSITION_VERSION,
    checkpointId,
    status: 'abandoned',
    decidedAt: now,
    updatedAt: now,
    reason: 'missing disposition',
    history: [{ status: 'abandoned', at: now, reason: 'missing disposition' }],
  }
}

function boundedReason(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return (normalized || 'checkpoint disposition').slice(0, MAX_REASON_LENGTH)
}

function normalizeId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > 512) throw new Error('invalid checkpoint disposition id')
  return normalized
}

function validTime(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('invalid disposition timestamp')
  return new Date(value).toISOString()
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value)) return fallback
  return Math.min(maximum, Math.max(minimum, value as number))
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
