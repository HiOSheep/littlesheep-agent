import type { EmbeddingEngine, EmbeddingEngineDescriptor, EmbeddingRequest, EmbeddingResult } from './contracts.js';

export class EmbeddingUnavailableError extends Error {
  constructor(message = 'No enabled local embedding engine is available.') {
    super(message);
    this.name = 'EmbeddingUnavailableError';
  }
}

export class DisabledEmbeddingEngine implements EmbeddingEngine {
  readonly descriptor: EmbeddingEngineDescriptor = {
    engineId: 'disabled',
    modelId: 'none',
    version: '1',
    dimensions: 0,
    transport: 'local',
  };

  isAvailable(): boolean {
    return false;
  }

  embed(_request: EmbeddingRequest): Promise<EmbeddingResult> {
    return Promise.reject(new EmbeddingUnavailableError());
  }
}

export function assertEmbeddingPolicy(engine: EmbeddingEngine, allowRemote: boolean): void {
  if (engine.descriptor.transport === 'remote' && !allowRemote) {
    throw new EmbeddingUnavailableError('Remote embedding is disabled by Memory v3 policy.');
  }
  if (!Number.isInteger(engine.descriptor.dimensions) || engine.descriptor.dimensions <= 0) {
    throw new Error('Embedding engine dimensions must be a positive integer.');
  }
}

export function validateEmbeddingResult(
  engine: EmbeddingEngine,
  request: EmbeddingRequest,
  result: EmbeddingResult,
): void {
  const expected = engine.descriptor;
  if (result.descriptor.engineId !== expected.engineId
    || result.descriptor.modelId !== expected.modelId
    || result.descriptor.version !== expected.version
    || result.descriptor.dimensions !== expected.dimensions) {
    throw new Error('Embedding result descriptor does not match the configured engine.');
  }
  if (result.vectors.length !== request.texts.length) {
    throw new Error(`Embedding engine returned ${result.vectors.length} vectors for ${request.texts.length} texts.`);
  }
  for (const vector of result.vectors) {
    if (vector.length !== expected.dimensions || vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`Embedding engine returned an invalid ${vector.length}-dimension vector.`);
    }
  }
}
