import type {
  LocalEmbeddingModelVerification,
  ProvisionLocalEmbeddingModelOptions,
} from '@littlesheep/embedding'
import { describe, expect, it, vi } from 'vitest'
import { MemoryEmbeddingModelManager } from './memory-embedding-model-control.js'

describe('Memory embedding model control', () => {
  it('reports verified local assets without exposing a filesystem path', async () => {
    const manager = new MemoryEmbeddingModelManager({
      dataDir: 'D:/isolated-data',
      verify: vi.fn(async () => verification(true, 25_000_000)),
    })

    const status = await manager.status()

    expect(status).toMatchObject({
      modelId: 'bge-small-zh-v1.5',
      state: 'ready',
      available: true,
      verifiedBytes: 25_000_000,
      missing: [],
      invalid: [],
    })
    expect(status).not.toHaveProperty('modelRoot')
  })

  it('distinguishes corrupt assets from files that have never been prepared', async () => {
    const manager = new MemoryEmbeddingModelManager({
      dataDir: 'D:/isolated-data',
      verify: vi.fn(async () => ({
        ...verification(false, 716),
        missing: ['onnx/model_quantized.onnx'],
        invalid: ['config.json'],
      })),
    })

    await expect(manager.status()).resolves.toMatchObject({
      state: 'invalid',
      available: false,
      verifiedBytes: 716,
      missing: ['onnx/model_quantized.onnx'],
      invalid: ['config.json'],
    })
  })

  it('starts one bounded preparation job and publishes progress until verification succeeds', async () => {
    let finish!: () => void
    let assetsReady = false
    const provision = vi.fn(async (options: ProvisionLocalEmbeddingModelOptions) => {
      options.onProgress?.({ file: 'onnx/model_quantized.onnx', completedBytes: 10, totalBytes: 100 })
      await new Promise<void>((resolve) => { finish = resolve })
      assetsReady = true
      return verification(true, 100)
    })
    const manager = new MemoryEmbeddingModelManager({
      dataDir: 'D:/isolated-data',
      verify: vi.fn(async () => verification(assetsReady, assetsReady ? 100 : 0)),
      provision,
    })

    const started = await manager.start()
    const duplicate = await manager.start()

    expect(started).toMatchObject({
      state: 'preparing',
      currentFile: 'onnx/model_quantized.onnx',
      completedBytes: 10,
      totalBytes: 100,
    })
    expect(duplicate.state).toBe('preparing')
    expect(provision).toHaveBeenCalledOnce()

    finish()
    await eventually(async () => (await manager.status()).state === 'ready')
    expect(await manager.status()).toMatchObject({ state: 'ready', available: true })
  })

  it('cancels an active download and returns to a retryable missing state', async () => {
    let receivedSignal: AbortSignal | undefined
    const provision = vi.fn((options: ProvisionLocalEmbeddingModelOptions) => {
      receivedSignal = options.signal
      return new Promise<LocalEmbeddingModelVerification>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const error = new Error('cancelled')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    })
    const manager = new MemoryEmbeddingModelManager({
      dataDir: 'D:/isolated-data',
      verify: vi.fn(async () => verification(false, 0)),
      provision,
    })

    await manager.start()
    const cancelled = await manager.cancel()

    expect(receivedSignal?.aborted).toBe(true)
    expect(cancelled).toMatchObject({ state: 'missing', available: false })
    expect(cancelled.error).toBeUndefined()
  })

  it('aborts active preparation when the Local App API server shuts down', async () => {
    let receivedSignal: AbortSignal | undefined
    const manager = new MemoryEmbeddingModelManager({
      dataDir: 'D:/isolated-data',
      verify: vi.fn(async () => verification(false, 0)),
      provision: vi.fn((options: ProvisionLocalEmbeddingModelOptions) => {
        receivedSignal = options.signal
        return new Promise<LocalEmbeddingModelVerification>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            const error = new Error('shutdown')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      }),
    })

    await manager.start()
    await manager.shutdown()

    expect(receivedSignal?.aborted).toBe(true)
    await expect(manager.status()).resolves.toMatchObject({ state: 'missing', available: false })
  })

  it('keeps a failed preparation visible and allows a later retry', async () => {
    let assetsReady = false
    const provision = vi.fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockImplementationOnce(async () => {
        assetsReady = true
        return verification(true, 25_000_000)
      })
    const manager = new MemoryEmbeddingModelManager({
      dataDir: 'D:/isolated-data',
      verify: vi.fn(async () => verification(assetsReady, assetsReady ? 25_000_000 : 0)),
      provision,
    })

    await manager.start()
    await eventually(async () => (await manager.status()).state === 'failed')
    expect(await manager.status()).toMatchObject({ state: 'failed', error: 'network unavailable' })

    await manager.start()
    await eventually(async () => (await manager.status()).state === 'ready')
    expect(provision).toHaveBeenCalledTimes(2)
  })
})

function verification(available: boolean, totalBytes: number): LocalEmbeddingModelVerification {
  return {
    available,
    modelRoot: 'D:/isolated-data/models/embedding/model',
    missing: available ? [] : ['config.json', 'onnx/model_quantized.onnx'],
    invalid: [],
    totalBytes,
  }
}

async function eventually(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Condition was not reached before the test deadline.')
}
