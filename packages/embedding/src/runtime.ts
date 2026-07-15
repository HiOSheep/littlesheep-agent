export interface FeatureExtractionOutput {
  tolist(): unknown;
  dispose?(): void;
}

export interface FeatureExtractionPipeline {
  (texts: string | string[], options: { pooling: 'mean'; normalize: true }): Promise<FeatureExtractionOutput>;
  dispose?(): Promise<void> | void;
}

export interface TransformersRuntimeEnvironment {
  cacheDir?: string;
  localModelPath?: string;
  allowRemoteModels?: boolean;
  allowLocalModels?: boolean;
  remoteHost?: string;
  useFSCache?: boolean;
}

export interface TransformersRuntime {
  env: TransformersRuntimeEnvironment;
  pipeline(
    task: 'feature-extraction',
    model: string,
    options: { dtype: 'q8'; revision: string },
  ): Promise<FeatureExtractionPipeline>;
}

export async function loadTransformersRuntime(): Promise<TransformersRuntime> {
  return await import('@huggingface/transformers') as unknown as TransformersRuntime;
}
