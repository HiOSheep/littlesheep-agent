// Owns local-only Transformers.js model loading, prefixing, normalization, and bounded batching.

import type {
  EmbeddingEngine,
  EmbeddingEngineDescriptor,
  EmbeddingRequest,
  EmbeddingResult,
} from '@littlesheep/memory-tree';
import { EmbeddingUnavailableError } from '@littlesheep/memory-tree';
import { getLocalEmbeddingModel, type LocalEmbeddingModelId, type LocalEmbeddingModelSpec } from './model-registry.js';
import { localEmbeddingModelRoot, verifyLocalEmbeddingModel } from './model-assets.js';
import {
  loadTransformersRuntime,
  type FeatureExtractionPipeline,
  type TransformersRuntime,
} from './runtime.js';

const DEFAULT_BATCH_SIZE = 16;

export interface LocalTransformersEmbeddingEngineOptions {
  model: LocalEmbeddingModelId;
  modelRootDir: string;
  batchSize?: number;
  runtimeLoader?: () => Promise<TransformersRuntime>;
  assetVerifier?: () => Promise<boolean>;
}

export class LocalTransformersEmbeddingEngine implements EmbeddingEngine {
  readonly descriptor: EmbeddingEngineDescriptor;
  private readonly spec: LocalEmbeddingModelSpec;
  private readonly modelRootDir: string;
  private readonly batchSize: number;
  private readonly runtimeLoader: () => Promise<TransformersRuntime>;
  private readonly assetVerifier: () => Promise<boolean>;
  private pipelinePromise?: Promise<FeatureExtractionPipeline>;
  private availabilityPromise?: Promise<boolean>;

  constructor(options: LocalTransformersEmbeddingEngineOptions) {
    this.spec = getLocalEmbeddingModel(options.model);
    this.modelRootDir = options.modelRootDir;
    this.batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE, 128);
    this.runtimeLoader = options.runtimeLoader ?? loadTransformersRuntime;
    this.assetVerifier = options.assetVerifier
      ?? (() => verifyLocalEmbeddingModel(this.spec.id, this.modelRootDir).then((result) => result.available));
    this.descriptor = {
      engineId: 'transformers-js-local',
      modelId: this.spec.id,
      version: `${this.spec.revision}:${this.spec.dtype}`,
      dimensions: this.spec.dimensions,
      transport: 'local',
    };
  }

  async isAvailable(): Promise<boolean> {
    const pending = this.availabilityPromise ??= this.assetVerifier().catch(() => false);
    const available = await pending;
    if (!available && this.availabilityPromise === pending) this.availabilityPromise = undefined;
    return available;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (request.texts.length === 0) return { vectors: [], descriptor: this.descriptor };
    if (request.signal?.aborted) throw abortError();
    if (!await this.isAvailable()) {
      throw new EmbeddingUnavailableError(`Local embedding model ${this.spec.id} is not provisioned or failed verification.`);
    }
    const pipeline = await this.getPipeline();
    const vectors: number[][] = [];
    for (let start = 0; start < request.texts.length; start += this.batchSize) {
      if (request.signal?.aborted) throw abortError();
      const batch = request.texts
        .slice(start, start + this.batchSize)
        .map((text) => prepareText(this.spec, request.purpose, text));
      const output = await pipeline(batch, { pooling: 'mean', normalize: true });
      try {
        vectors.push(...parseVectors(output.tolist(), batch.length, this.spec.dimensions));
      } finally {
        output.dispose?.();
      }
    }
    return { vectors, descriptor: this.descriptor };
  }

  async dispose(): Promise<void> {
    const pending = this.pipelinePromise;
    this.pipelinePromise = undefined;
    if (!pending) return;
    const pipeline = await pending.catch(() => undefined);
    await pipeline?.dispose?.();
  }

  private getPipeline(): Promise<FeatureExtractionPipeline> {
    this.pipelinePromise ??= this.createPipeline().catch((error: unknown) => {
      this.pipelinePromise = undefined;
      throw error;
    });
    return this.pipelinePromise;
  }

  private async createPipeline(): Promise<FeatureExtractionPipeline> {
    const runtime = await this.runtimeLoader();
    const localRoot = localEmbeddingModelRoot(this.spec.id, this.modelRootDir);
    runtime.env.localModelPath = ensureTrailingSlash(localRoot);
    runtime.env.allowLocalModels = true;
    runtime.env.allowRemoteModels = false;
    runtime.env.useFSCache = false;
    try {
      return await runtime.pipeline('feature-extraction', this.spec.repository, {
        dtype: this.spec.dtype,
        revision: this.spec.revision,
      });
    } catch (error) {
      throw new EmbeddingUnavailableError(
        `Local embedding model ${this.spec.id} could not be loaded from ${localRoot}: ${errorMessage(error)}`,
      );
    }
  }
}

function prepareText(spec: LocalEmbeddingModelSpec, purpose: EmbeddingRequest['purpose'], text: string): string {
  const normalized = text.normalize('NFKC').replace(/\u0000/gu, '').trim();
  const prefix = purpose === 'query' ? spec.queryPrefix : spec.documentPrefix;
  return `${prefix}${normalized}`.slice(0, spec.maxCharacters);
}

function parseVectors(value: unknown, expectedRows: number, dimensions: number): number[][] {
  if (!Array.isArray(value)) throw new Error('Embedding runtime returned a non-array tensor.');
  const rows = expectedRows === 1 && value.length === dimensions && value.every((item) => typeof item === 'number')
    ? [value]
    : value;
  if (rows.length !== expectedRows) {
    throw new Error(`Embedding runtime returned ${rows.length} rows for ${expectedRows} texts.`);
  }
  return rows.map((row, index) => {
    if (!Array.isArray(row) || row.length !== dimensions || row.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
      throw new Error(`Embedding runtime returned an invalid vector at row ${index}.`);
    }
    return row as number[];
  });
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isInteger(value) || value! <= 0) return fallback;
  return Math.min(value!, maximum);
}

function abortError(): Error {
  const error = new Error('Local embedding was aborted.');
  error.name = 'AbortError';
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
