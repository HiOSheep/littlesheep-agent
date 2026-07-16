// Owns explicit, cancellable preparation of the fixed local Memory v3 embedding model.

import { join } from 'node:path'
import {
  DEFAULT_LOCAL_EMBEDDING_MODEL,
  getLocalEmbeddingModel,
  provisionLocalEmbeddingModel,
  verifyLocalEmbeddingModel,
  type LocalEmbeddingModelId,
  type LocalEmbeddingModelVerification,
  type ProvisionLocalEmbeddingModelOptions,
} from '@littlesheep/embedding'
import type { MemoryEmbeddingModelStatus } from '../shared/memory-control-contracts.js'

type VerifyModel = (
  model: LocalEmbeddingModelId,
  modelRootDir: string,
) => Promise<LocalEmbeddingModelVerification>

type ProvisionModel = (
  options: ProvisionLocalEmbeddingModelOptions,
) => Promise<LocalEmbeddingModelVerification>

type VerificationOutcome = LocalEmbeddingModelVerification & { verificationError?: string }

export interface MemoryEmbeddingModelController {
  status(): Promise<MemoryEmbeddingModelStatus>
  start(): Promise<MemoryEmbeddingModelStatus>
  cancel(): Promise<MemoryEmbeddingModelStatus>
  shutdown(): Promise<void>
}

export interface MemoryEmbeddingModelManagerOptions {
  dataDir: string
  model?: LocalEmbeddingModelId
  verify?: VerifyModel
  provision?: ProvisionModel
  now?: () => Date
}

export class MemoryEmbeddingModelManager implements MemoryEmbeddingModelController {
  private readonly model: LocalEmbeddingModelId
  private readonly modelRootDir: string
  private readonly requiredBytes: number
  private readonly verify: VerifyModel
  private readonly provision: ProvisionModel
  private readonly now: () => Date
  private current?: MemoryEmbeddingModelStatus
  private activeRun?: Promise<void>
  private controller?: AbortController
  private actionChain: Promise<void> = Promise.resolve()

  constructor(options: MemoryEmbeddingModelManagerOptions) {
    this.model = options.model ?? DEFAULT_LOCAL_EMBEDDING_MODEL
    this.modelRootDir = join(options.dataDir, 'models', 'embedding')
    this.requiredBytes = getLocalEmbeddingModel(this.model).files.reduce((sum, file) => sum + file.bytes, 0)
    this.verify = options.verify ?? verifyLocalEmbeddingModel
    this.provision = options.provision ?? provisionLocalEmbeddingModel
    this.now = options.now ?? (() => new Date())
  }

  async status(): Promise<MemoryEmbeddingModelStatus> {
    if (this.activeRun && this.current) return cloneStatus(this.current)
    const verification = await this.safeVerify()
    this.current = this.statusFromVerification(verification, this.current?.state === 'failed' ? this.current.error : undefined)
    return cloneStatus(this.current)
  }

  start(): Promise<MemoryEmbeddingModelStatus> {
    return this.exclusive(async () => {
      if (this.activeRun && this.current) return cloneStatus(this.current)
      const verification = await this.safeVerify()
      if (verification.available) {
        this.current = this.statusFromVerification(verification)
        return cloneStatus(this.current)
      }

      const startedAt = this.timestamp()
      const controller = new AbortController()
      this.controller = controller
      this.current = {
        ...this.statusFromVerification(verification),
        state: 'preparing',
        currentFile: verification.missing[0] ?? verification.invalid[0],
        startedAt,
        updatedAt: startedAt,
      }
      const run = this.runProvision(controller, startedAt)
        .finally(() => {
          if (this.activeRun === run) this.activeRun = undefined
          if (this.controller === controller) this.controller = undefined
        })
      this.activeRun = run
      void run
      return cloneStatus(this.current)
    })
  }

  cancel(): Promise<MemoryEmbeddingModelStatus> {
    return this.exclusive(async () => {
      const active = this.activeRun
      this.controller?.abort()
      await active
      return this.status()
    })
  }

  async shutdown(): Promise<void> {
    const active = this.activeRun
    this.controller?.abort()
    await active
  }

  private async runProvision(controller: AbortController, startedAt: string): Promise<void> {
    try {
      const verification = await this.provision({
        model: this.model,
        modelRootDir: this.modelRootDir,
        signal: controller.signal,
        onProgress: (progress) => {
          if (controller.signal.aborted) return
          this.current = {
            modelId: this.model,
            state: 'preparing',
            available: false,
            requiredBytes: this.requiredBytes,
            verifiedBytes: this.current?.verifiedBytes ?? 0,
            completedBytes: boundedBytes(progress.completedBytes, progress.totalBytes),
            totalBytes: progress.totalBytes,
            missing: this.current?.missing ?? [],
            invalid: this.current?.invalid ?? [],
            currentFile: progress.file,
            startedAt,
            updatedAt: this.timestamp(),
          }
        },
      })
      this.current = this.statusFromVerification(verification)
    } catch (error) {
      const verification = await this.safeVerify()
      this.current = this.statusFromVerification(
        verification,
        isAbortError(error) ? undefined : errorMessage(error),
      )
    }
  }

  private async safeVerify(): Promise<VerificationOutcome> {
    try {
      return await this.verify(this.model, this.modelRootDir)
    } catch (error) {
      return {
        available: false,
        modelRoot: this.modelRootDir,
        missing: [],
        invalid: [],
        totalBytes: 0,
        verificationError: errorMessage(error),
      }
    }
  }

  private statusFromVerification(
    verification: VerificationOutcome,
    error = verification.verificationError,
  ): MemoryEmbeddingModelStatus {
    const state = verification.available
      ? 'ready'
      : error
        ? 'failed'
        : verification.invalid.length > 0
          ? 'invalid'
          : 'missing'
    return {
      modelId: this.model,
      state,
      available: verification.available,
      requiredBytes: this.requiredBytes,
      verifiedBytes: verification.totalBytes,
      completedBytes: verification.totalBytes,
      totalBytes: this.requiredBytes,
      missing: [...verification.missing],
      invalid: [...verification.invalid],
      error,
      updatedAt: this.timestamp(),
    }
  }

  private timestamp(): string {
    return this.now().toISOString()
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.actionChain
    let release!: () => void
    this.actionChain = new Promise<void>((resolve) => { release = resolve })
    await prior
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function boundedBytes(completed: number, total: number): number {
  if (!Number.isFinite(completed) || completed <= 0) return 0
  if (!Number.isFinite(total) || total <= 0) return Math.floor(completed)
  return Math.min(Math.floor(completed), Math.floor(total))
}

function cloneStatus(status: MemoryEmbeddingModelStatus): MemoryEmbeddingModelStatus {
  return structuredClone(status)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
