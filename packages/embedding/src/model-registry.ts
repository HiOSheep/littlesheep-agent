export type LocalEmbeddingModelId = 'bge-small-zh-v1.5' | 'multilingual-e5-small';

export const DEFAULT_LOCAL_EMBEDDING_MODEL: LocalEmbeddingModelId = 'bge-small-zh-v1.5';

export interface LocalEmbeddingModelSpec {
  id: LocalEmbeddingModelId;
  repository: string;
  revision: string;
  upstreamRepository: string;
  license: 'MIT';
  dimensions: number;
  dtype: 'q8';
  queryPrefix: string;
  documentPrefix: string;
  maxCharacters: number;
  quantizedOnnxBytes: number;
  files: LocalEmbeddingModelFile[];
}

export interface LocalEmbeddingModelFile {
  path: string;
  bytes: number;
  sha256: string;
}

export const LOCAL_EMBEDDING_MODELS: Record<LocalEmbeddingModelId, LocalEmbeddingModelSpec> = {
  'bge-small-zh-v1.5': {
    id: 'bge-small-zh-v1.5',
    repository: 'Xenova/bge-small-zh-v1.5',
    revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781',
    upstreamRepository: 'BAAI/bge-small-zh-v1.5',
    license: 'MIT',
    dimensions: 512,
    dtype: 'q8',
    queryPrefix: '为这个句子生成表示以用于检索相关文章：',
    documentPrefix: '',
    maxCharacters: 16_000,
    quantizedOnnxBytes: 24_010_842,
    files: [
      { path: 'config.json', bytes: 716, sha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f' },
      { path: 'tokenizer.json', bytes: 439_125, sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26' },
      { path: 'tokenizer_config.json', bytes: 367, sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a' },
      { path: 'onnx/model_quantized.onnx', bytes: 24_010_842, sha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc' },
    ],
  },
  'multilingual-e5-small': {
    id: 'multilingual-e5-small',
    repository: 'Xenova/multilingual-e5-small',
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    upstreamRepository: 'intfloat/multilingual-e5-small',
    license: 'MIT',
    dimensions: 384,
    dtype: 'q8',
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
    maxCharacters: 16_000,
    quantizedOnnxBytes: 118_308_185,
    files: [
      { path: 'config.json', bytes: 658, sha256: 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1' },
      { path: 'tokenizer.json', bytes: 17_082_730, sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' },
      { path: 'tokenizer_config.json', bytes: 443, sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b' },
      { path: 'sentencepiece.bpe.model', bytes: 5_069_051, sha256: 'cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865' },
      { path: 'onnx/model_quantized.onnx', bytes: 118_308_185, sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193' },
    ],
  },
};

export function getLocalEmbeddingModel(id: LocalEmbeddingModelId): LocalEmbeddingModelSpec {
  return LOCAL_EMBEDDING_MODELS[id];
}
