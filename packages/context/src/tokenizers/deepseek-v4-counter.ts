// Owns verified DeepSeek V4 tokenizer assets, bounded count caching, and the
// exact request-counter adapter used by Context Engine.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import { DEEPSEEK_V41_TOKEN_COUNTER_ID, DEEPSEEK_V4_TOKEN_COUNTER_ID } from '@littlesheep/config';
import type { ChatRequest } from '@littlesheep/llm';
import {
  cleanupVerifiedAssetTemporaryFiles,
  downloadVerifiedAsset,
  inspectVerifiedAssetFile,
} from '@littlesheep/safety/verified-asset';
import type { ExactContextTokenCounter } from '../context-engine/contracts.js';
import { encodeDeepSeekV4Request, type DeepSeekFraming } from './deepseek-v4-encoding.js';

interface DeepSeekTokenizerSpec {
  readonly id: string;
  readonly repository: string;
  readonly revision: string;
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
}

const DEEPSEEK_V4_TOKENIZER_SPEC: DeepSeekTokenizerSpec = Object.freeze({
  id: 'deepseek-v4',
  repository: 'deepseek-ai/DeepSeek-V4-Flash',
  revision: '60d8d70770c6776ff598c94bb586a859a38244f1',
  files: Object.freeze([
    Object.freeze({
      path: 'tokenizer.json',
      bytes: 6_367_146,
      sha256: '8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf',
    }),
    Object.freeze({
      path: 'tokenizer_config.json',
      bytes: 801,
      sha256: '6ac8c8dc065ed118161d02dd532749ae3f52c243deac27872134fae2f50d8547',
    }),
  ]),
});

/**
 * V4.1 ships its own tokenizer. The pinned revision below is what the live
 * calibration matrix was measured against: five request shapes (thinking
 * disabled, thinking high, thinking max, single tool, multi tool) reproduced
 * Provider prompt tokens exactly, while the V4 assets off by -1/+9 and the V4
 * tokenizer cannot even represent `<｜System｜>` as one token.
 */
const DEEPSEEK_V41_TOKENIZER_SPEC: DeepSeekTokenizerSpec = Object.freeze({
  id: 'deepseek-v4.1',
  repository: 'deepseek-ai/DeepSeek-V4.1-Flash',
  revision: 'dba1be0a40aa45a94ad051997016db3960a90277',
  files: Object.freeze([
    Object.freeze({
      path: 'tokenizer.json',
      bytes: 6_367_257,
      sha256: 'c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b',
    }),
    Object.freeze({
      path: 'tokenizer_config.json',
      bytes: 801,
      sha256: '6ac8c8dc065ed118161d02dd532749ae3f52c243deac27872134fae2f50d8547',
    }),
  ]),
});

export interface DeepSeekTokenizerFamily {
  counterId: string;
  framing: DeepSeekFraming;
  /** Models whose hosted service uses this tokenizer + framing pair. */
  models: readonly string[];
  spec: DeepSeekTokenizerSpec;
  /** Tool-protocol shapes verified against real Provider usage for this family. */
  toolProtocolCalibrated: boolean;
}

const DEEPSEEK_V4_FAMILY: DeepSeekTokenizerFamily = Object.freeze({
  counterId: DEEPSEEK_V4_TOKEN_COUNTER_ID,
  framing: 'v4',
  // `deepseek-v4-pro` still serves the V4 architecture until DeepSeek routes it
  // to V4.1; see the changelog note in @littlesheep/config.
  models: Object.freeze(['deepseek-v4-pro']),
  spec: DEEPSEEK_V4_TOKENIZER_SPEC,
  // V4 Pro tool protocol was never calibrated; only the retired V4 Flash was.
  toolProtocolCalibrated: false,
});

const DEEPSEEK_V41_FAMILY: DeepSeekTokenizerFamily = Object.freeze({
  counterId: DEEPSEEK_V41_TOKEN_COUNTER_ID,
  framing: 'v4.1',
  models: Object.freeze(['deepseek-flash', 'deepseek-v4-flash']),
  spec: DEEPSEEK_V41_TOKENIZER_SPEC,
  // Measured: single-tool 295/295 and multi-tool 349/349 against the Provider.
  toolProtocolCalibrated: true,
});

const DEEPSEEK_TOKENIZER_FAMILIES = Object.freeze([DEEPSEEK_V4_FAMILY, DEEPSEEK_V41_FAMILY]);

export interface LocalTokenizerPreparationOptions {
  modelRef: string;
  modelRootDir: string;
  remoteHost?: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: { file: string; completedBytes: number; totalBytes: number }) => void;
}

export interface LazyLocalTokenizerCounterOptions extends LocalTokenizerPreparationOptions {
  /** Minimum delay before a failed preparation may start another network request. */
  retryBackoffMs?: number;
  onPreparationError?: (error: Error) => void;
}

export interface LazyExactContextTokenCounter extends ExactContextTokenCounter {
  readonly ready: boolean;
  /** Starts or joins verified asset preparation without blocking application startup. */
  prepare(): Promise<void>;
  dispose(): void;
}

export interface LocalTokenizerVerification {
  available: boolean;
  modelRoot: string;
  missing: string[];
  invalid: string[];
  totalBytes: number;
}

export interface DeepSeekV4TokenizerLike {
  encode(text: string, options?: { add_special_tokens?: boolean }): { ids: Array<number | bigint> };
}

let cachedCounter: {
  key: string;
  promise: Promise<ExactContextTokenCounter>;
} | undefined;

/** Prepare the immutable tokenizer before the Runner accepts work. */
export async function prepareLocalExactContextTokenCounter(
  options: LocalTokenizerPreparationOptions,
): Promise<ExactContextTokenCounter | undefined> {
  if (!isDeepSeekV4ModelRef(options.modelRef)) return undefined;
  const key = `${resolve(options.modelRootDir)}|${resolveDeepSeekTokenizerFamily(options.modelRef)?.counterId ?? ''}`;
  if (cachedCounter?.key === key) return cachedCounter.promise;

  const promise = prepareDeepSeekV4Counter(options);
  cachedCounter = { key, promise };
  try {
    return await promise;
  } catch (error) {
    if (cachedCounter?.promise === promise) cachedCounter = undefined;
    throw error;
  }
}

/**
 * Return a synchronous Context Engine counter facade while keeping immutable
 * tokenizer verification/provisioning off the application startup path.
 * Until preparation completes, countRequest fails closed and Context Engine
 * uses its conservative request-size safety estimator.
 */
export function createLazyLocalExactContextTokenCounter(
  options: LazyLocalTokenizerCounterOptions,
): LazyExactContextTokenCounter | undefined {
  if (!isDeepSeekV4ModelRef(options.modelRef)) return undefined;

  const lifecycle = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, lifecycle.signal])
    : lifecycle.signal;
  const retryBackoffMs = Math.max(0, options.retryBackoffMs ?? 60_000);
  let counter: ExactContextTokenCounter | undefined;
  let preparation: Promise<void> | undefined;
  let lastFailure: { error: Error; at: number } | undefined;
  let disposed = false;

  const prepare = (): Promise<void> => {
    if (counter) return Promise.resolve();
    if (disposed) return Promise.reject(new Error('Exact token counter has been disposed.'));
    if (preparation) return preparation;
    if (lastFailure && Date.now() - lastFailure.at < retryBackoffMs) {
      return Promise.reject(lastFailure.error);
    }

    lastFailure = undefined;
    const pending = prepareLocalExactContextTokenCounter({ ...options, signal })
      .then((prepared) => {
        if (!prepared) throw new Error(`No exact token counter is registered for ${options.modelRef}.`);
        if (!disposed) counter = prepared;
      })
      .catch((error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (!disposed) {
          lastFailure = { error: normalized, at: Date.now() };
          options.onPreparationError?.(normalized);
        }
        throw normalized;
      })
      .finally(() => {
        if (preparation === pending) preparation = undefined;
      });
    preparation = pending;
    return pending;
  };

  return {
    id: DEEPSEEK_V4_TOKEN_COUNTER_ID,
    get ready(): boolean {
      return counter !== undefined;
    },
    supports(provider: string, model: string): boolean {
      return provider.trim().toLowerCase() === 'deepseek' && isDeepSeekV4Model(model);
    },
    countRequest(request: ChatRequest): number {
      if (counter) return counter.countRequest(request);
      const failure = lastFailure;
      void prepare().catch(() => undefined);
      if (failure && Date.now() - failure.at < retryBackoffMs) {
        throw new Error(`Verified exact tokenizer is temporarily unavailable: ${failure.error.message}`);
      }
      throw new Error('Verified exact tokenizer is preparing; conservative context estimation is active.');
    },
    prepare,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      lifecycle.abort(new Error('Exact token counter lifecycle ended.'));
      counter = undefined;
    },
  };
}

export function createDeepSeekV4ExactContextTokenCounter(
  tokenizer: DeepSeekV4TokenizerLike,
  family: DeepSeekTokenizerFamily = DEEPSEEK_V4_FAMILY,
): ExactContextTokenCounter {
  const recentCounts = new Map<string, number>();
  return Object.freeze({
    id: family.counterId,
    supports(provider: string, model: string): boolean {
      return provider.trim().toLowerCase() === 'deepseek'
        && family.models.includes(model.trim().toLowerCase());
    },
    countRequest(request: ChatRequest): number {
      if (!family.models.includes(request.model.trim().toLowerCase())) {
        throw new Error(
          `${family.counterId} does not cover ${request.model}; use the counter registered for that model.`,
        );
      }
      if (request.thinking?.type !== 'enabled' && request.thinking?.type !== 'disabled') {
        throw new Error(
          'DeepSeek V4 exact counting requires an explicit thinking mode because Provider defaults are not stable request framing.',
        );
      }
      assertCalibratedRequestShape(request, family);
      const prompt = encodeDeepSeekV4Request(request, family.framing);
      const controlTokens = providerControlTokenAdjustment(request, family);
      const cacheKey = createHash('sha256').update(`${controlTokens}\0${prompt}`).digest('hex');
      const cached = recentCounts.get(cacheKey);
      if (cached !== undefined) return cached;
      const count = tokenizer.encode(prompt, { add_special_tokens: false }).ids.length + controlTokens;
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('DeepSeek V4 tokenizer returned an invalid token count.');
      recentCounts.set(cacheKey, count);
      if (recentCounts.size > 64) recentCounts.delete(recentCounts.keys().next().value!);
      return count;
    },
  });
}

function assertCalibratedRequestShape(request: ChatRequest, family: DeepSeekTokenizerFamily): void {
  const thinkingEnabled = request.thinking?.type === 'enabled';
  if (thinkingEnabled && request.reasoning_effort !== 'high' && request.reasoning_effort !== 'max') {
    throw new Error(
      'DeepSeek V4 exact counting requires explicit reasoning_effort=high|max when thinking is enabled.',
    );
  }
  if (!thinkingEnabled && request.reasoning_effort !== undefined) {
    throw new Error(
      'DeepSeek V4 exact counting does not cover reasoning_effort when thinking is disabled.',
    );
  }

  const activeToolSchema = (request.tools?.length ?? 0) > 0;
  const historicalToolProtocol = request.messages.some((message) => (
    message.role === 'tool' || (message.tool_calls?.length ?? 0) > 0
  ));
  if (!activeToolSchema && !historicalToolProtocol) return;

  const model = request.model.trim().toLowerCase();
  if (!family.toolProtocolCalibrated) {
    throw new Error(
      `${family.counterId} does not cover tool protocol requests for ${model} pending model-specific Provider calibration.`,
    );
  }
  if (!activeToolSchema && historicalToolProtocol) {
    // Live measurement: a transcript that keeps tool history but drops the tool
    // schema is one token off, so this shape stays explicitly uncovered instead
    // of returning a near-but-wrong count.
    throw new Error(
      'Exact counting does not cover tool history without an active tool schema.',
    );
  }
  // `tool_choice=none` keeps the tool schema in the request (so the cacheable
  // prefix is unchanged) while forbidding a call; the schema is still the active
  // tool schema, so the request is counted with it. Other non-auto choices stay
  // uncovered rather than silently miscounted.
  if (activeToolSchema && request.tool_choice !== 'auto' && request.tool_choice !== 'none') {
    throw new Error(
      'Exact counting requires tool_choice=auto when tools are present.',
    );
  }
  if (!activeToolSchema && request.tool_choice !== undefined) {
    throw new Error(
      'Exact counting does not cover tool_choice without an active tool schema.',
    );
  }
}

/**
 * Both live-calibrated families reproduce Provider prompt tokens with the
 * published framing alone; the retired hosted V4 Flash max-effort control
 * segment is no longer applied by any served model.
 */
function providerControlTokenAdjustment(request: ChatRequest, family: DeepSeekTokenizerFamily): number {
  if (!family.models.includes(request.model.trim().toLowerCase())) return 0;
  return 0;
}

export async function verifyDeepSeekV4TokenizerAssets(
  modelRootDir: string,
  spec: DeepSeekTokenizerSpec = DEEPSEEK_V4_TOKENIZER_SPEC,
): Promise<LocalTokenizerVerification> {
  const modelRoot = tokenizerRevisionRoot(modelRootDir, spec);
  const repositoryRoot = join(modelRoot, ...spec.repository.split('/'));
  const missing: string[] = [];
  const invalid: string[] = [];
  let totalBytes = 0;
  for (const file of spec.files) {
    const path = join(repositoryRoot, file.path);
    const status = await inspectVerifiedAssetFile(path, file);
    if (status === 'missing') missing.push(file.path);
    else if (status === 'invalid') invalid.push(file.path);
    else totalBytes += file.bytes;
  }
  return {
    available: missing.length === 0 && invalid.length === 0,
    modelRoot,
    missing,
    invalid,
    totalBytes,
  };
}

async function prepareDeepSeekV4Counter(
  options: LocalTokenizerPreparationOptions,
): Promise<ExactContextTokenCounter> {
  const family = resolveDeepSeekTokenizerFamily(options.modelRef);
  if (!family) {
    throw new Error(`No DeepSeek tokenizer family is registered for ${options.modelRef}.`);
  }
  let verification = await verifyDeepSeekV4TokenizerAssets(options.modelRootDir, family.spec);
  if (!verification.available) {
    verification = await provisionDeepSeekV4TokenizerAssets(options, family.spec);
  }
  const repositoryRoot = join(
    verification.modelRoot,
    ...family.spec.repository.split('/'),
  );
  const [tokenizerJson, tokenizerConfig] = await Promise.all([
    readJson(join(repositoryRoot, 'tokenizer.json')),
    readJson(join(repositoryRoot, 'tokenizer_config.json')),
  ]);
  return createDeepSeekV4ExactContextTokenCounter(new Tokenizer(tokenizerJson, tokenizerConfig), family);
}

async function provisionDeepSeekV4TokenizerAssets(
  options: LocalTokenizerPreparationOptions,
  spec: DeepSeekTokenizerSpec = DEEPSEEK_V4_TOKENIZER_SPEC,
): Promise<LocalTokenizerVerification> {
  const fetchFn = options.fetchFn ?? fetch;
  const remoteHost = ensureTrailingSlash(options.remoteHost ?? 'https://huggingface.co');
  const modelRoot = tokenizerRevisionRoot(options.modelRootDir, spec);
  const repositoryRoot = join(modelRoot, ...spec.repository.split('/'));
  await mkdir(repositoryRoot, { recursive: true });
  const totalBytes = spec.files.reduce((sum, file) => sum + file.bytes, 0);
  let completedBytes = 0;
  const timeout = createTimeoutSignal(options.signal, options.timeoutMs ?? 30_000);
  try {
    for (const file of spec.files) {
      const destination = join(repositoryRoot, file.path);
      if (await inspectVerifiedAssetFile(destination, file) === 'valid') {
        await cleanupVerifiedAssetTemporaryFiles(destination, timeout.signal);
        completedBytes += file.bytes;
        options.onProgress?.({ file: file.path, completedBytes, totalBytes });
        continue;
      }
      const url = new URL(
        `${spec.repository}/resolve/${spec.revision}/${file.path}`,
        remoteHost,
      ).toString();
      await downloadVerifiedAsset({
        fetchFn,
        url,
        destination,
        expected: file,
        signal: timeout.signal,
        label: 'Tokenizer asset',
        onBytes: (written) => {
          options.onProgress?.({ file: file.path, completedBytes: completedBytes + written, totalBytes });
        },
      });
      completedBytes += file.bytes;
      options.onProgress?.({ file: file.path, completedBytes, totalBytes });
    }
  } finally {
    timeout.dispose();
  }

  const verification = await verifyDeepSeekV4TokenizerAssets(options.modelRootDir, spec);
  if (!verification.available) {
    throw new Error(`DeepSeek V4 tokenizer verification failed: missing=${verification.missing.join(',')}; invalid=${verification.invalid.join(',')}`);
  }
  await writeFile(join(modelRoot, 'model-manifest.json'), `${JSON.stringify({
    version: 1,
    id: spec.id,
    repository: spec.repository,
    revision: spec.revision,
    counterId: spec.files.length > 0 ? resolveCounterIdForSpec(spec.id) : DEEPSEEK_V4_TOKEN_COUNTER_ID,
    files: spec.files,
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
  return verification;
}

async function readJson(path: string): Promise<object> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Tokenizer asset is not a JSON object: ${path}`);
  }
  return parsed;
}

function tokenizerRevisionRoot(modelRootDir: string, spec: DeepSeekTokenizerSpec): string {
  return join(resolve(modelRootDir), spec.id, spec.revision);
}

function isDeepSeekV4ModelRef(modelRef: string): boolean {
  return resolveDeepSeekTokenizerFamily(modelRef) !== undefined;
}

function isDeepSeekV4Model(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return DEEPSEEK_TOKENIZER_FAMILIES.some((family) => family.models.includes(normalized));
}

/** Map a `provider/model` reference onto the tokenizer + framing pair it uses. */
export function resolveDeepSeekTokenizerFamily(modelRef: string): DeepSeekTokenizerFamily | undefined {
  const normalized = modelRef.trim().toLowerCase();
  const slash = normalized.indexOf('/');
  if (slash <= 0 || normalized.slice(0, slash) !== 'deepseek') return undefined;
  const model = normalized.slice(slash + 1);
  return DEEPSEEK_TOKENIZER_FAMILIES.find((family) => family.models.includes(model));
}

function resolveCounterIdForSpec(specId: string): string {
  return DEEPSEEK_TOKENIZER_FAMILIES.find((family) => family.spec.id === specId)?.counterId
    ?? DEEPSEEK_V4_TOKEN_COUNTER_ID;
}

function createTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Tokenizer asset preparation timed out.')), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
