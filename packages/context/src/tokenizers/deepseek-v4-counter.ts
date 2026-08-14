// Owns verified DeepSeek V4 tokenizer assets, bounded count caching, and the
// exact request-counter adapter used by Context Engine.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import { DEEPSEEK_V4_TOKEN_COUNTER_ID } from '@littlesheep/config';
import type { ChatRequest } from '@littlesheep/llm';
import type { ExactContextTokenCounter } from '../context-engine/contracts.js';
import { encodeDeepSeekV4Request } from './deepseek-v4-encoding.js';

const DEEPSEEK_V4_TOKENIZER_SPEC = Object.freeze({
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

// The hosted Flash API adds a non-public max-effort control segment after the
// published prompt framing. Its fixed token cost is verified by the live
// calibration matrix; it is not representable by the open-weights encoder.
const DEEPSEEK_V4_FLASH_MAX_CONTROL_TOKENS = 13;

type TokenizerFileSpec = typeof DEEPSEEK_V4_TOKENIZER_SPEC.files[number];

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
  const key = resolve(options.modelRootDir);
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
): ExactContextTokenCounter {
  const recentCounts = new Map<string, number>();
  return Object.freeze({
    id: DEEPSEEK_V4_TOKEN_COUNTER_ID,
    supports(provider: string, model: string): boolean {
      return provider.trim().toLowerCase() === 'deepseek' && isDeepSeekV4Model(model);
    },
    countRequest(request: ChatRequest): number {
      if (request.thinking?.type !== 'enabled' && request.thinking?.type !== 'disabled') {
        throw new Error(
          'DeepSeek V4 exact counting requires an explicit thinking mode because Provider defaults are not stable request framing.',
        );
      }
      assertCalibratedRequestShape(request);
      const prompt = encodeDeepSeekV4Request(request);
      const controlTokens = providerControlTokenAdjustment(request);
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

function assertCalibratedRequestShape(request: ChatRequest): void {
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
  if (model !== 'deepseek-v4-flash') {
    throw new Error(
      'DeepSeek V4 Pro exact counting is unavailable for tool protocol requests pending model-specific Provider calibration.',
    );
  }
  if (activeToolSchema && request.tool_choice !== 'auto') {
    throw new Error(
      'DeepSeek V4 Flash exact counting requires tool_choice=auto when tools are present.',
    );
  }
  if (!activeToolSchema && request.tool_choice !== undefined) {
    throw new Error(
      'DeepSeek V4 Flash exact counting does not cover tool_choice without an active tool schema.',
    );
  }
}

function providerControlTokenAdjustment(request: ChatRequest): number {
  return request.model.trim().toLowerCase() === 'deepseek-v4-flash'
    && request.thinking?.type === 'enabled'
    && request.reasoning_effort === 'max'
    ? DEEPSEEK_V4_FLASH_MAX_CONTROL_TOKENS
    : 0;
}

export async function verifyDeepSeekV4TokenizerAssets(
  modelRootDir: string,
): Promise<LocalTokenizerVerification> {
  const modelRoot = tokenizerRevisionRoot(modelRootDir);
  const repositoryRoot = join(modelRoot, ...DEEPSEEK_V4_TOKENIZER_SPEC.repository.split('/'));
  const missing: string[] = [];
  const invalid: string[] = [];
  let totalBytes = 0;
  for (const file of DEEPSEEK_V4_TOKENIZER_SPEC.files) {
    const path = join(repositoryRoot, file.path);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size !== file.bytes || await hashFile(path) !== file.sha256) {
        invalid.push(file.path);
      } else {
        totalBytes += info.size;
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') missing.push(file.path);
      else throw error;
    }
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
  let verification = await verifyDeepSeekV4TokenizerAssets(options.modelRootDir);
  if (!verification.available) {
    verification = await provisionDeepSeekV4TokenizerAssets(options);
  }
  const repositoryRoot = join(
    verification.modelRoot,
    ...DEEPSEEK_V4_TOKENIZER_SPEC.repository.split('/'),
  );
  const [tokenizerJson, tokenizerConfig] = await Promise.all([
    readJson(join(repositoryRoot, 'tokenizer.json')),
    readJson(join(repositoryRoot, 'tokenizer_config.json')),
  ]);
  return createDeepSeekV4ExactContextTokenCounter(new Tokenizer(tokenizerJson, tokenizerConfig));
}

async function provisionDeepSeekV4TokenizerAssets(
  options: LocalTokenizerPreparationOptions,
): Promise<LocalTokenizerVerification> {
  const fetchFn = options.fetchFn ?? fetch;
  const remoteHost = ensureTrailingSlash(options.remoteHost ?? 'https://huggingface.co');
  const modelRoot = tokenizerRevisionRoot(options.modelRootDir);
  const repositoryRoot = join(modelRoot, ...DEEPSEEK_V4_TOKENIZER_SPEC.repository.split('/'));
  await mkdir(repositoryRoot, { recursive: true });
  const totalBytes = DEEPSEEK_V4_TOKENIZER_SPEC.files.reduce((sum, file) => sum + file.bytes, 0);
  let completedBytes = 0;
  const timeout = createTimeoutSignal(options.signal, options.timeoutMs ?? 30_000);
  try {
    for (const file of DEEPSEEK_V4_TOKENIZER_SPEC.files) {
      const destination = join(repositoryRoot, file.path);
      if (await fileMatches(destination, file)) {
        completedBytes += file.bytes;
        options.onProgress?.({ file: file.path, completedBytes, totalBytes });
        continue;
      }
      const url = new URL(
        `${DEEPSEEK_V4_TOKENIZER_SPEC.repository}/resolve/${DEEPSEEK_V4_TOKENIZER_SPEC.revision}/${file.path}`,
        remoteHost,
      ).toString();
      await downloadVerifiedFile(fetchFn, url, destination, file, timeout.signal, (written) => {
        options.onProgress?.({ file: file.path, completedBytes: completedBytes + written, totalBytes });
      });
      completedBytes += file.bytes;
      options.onProgress?.({ file: file.path, completedBytes, totalBytes });
    }
  } finally {
    timeout.dispose();
  }

  const verification = await verifyDeepSeekV4TokenizerAssets(options.modelRootDir);
  if (!verification.available) {
    throw new Error(`DeepSeek V4 tokenizer verification failed: missing=${verification.missing.join(',')}; invalid=${verification.invalid.join(',')}`);
  }
  await writeFile(join(modelRoot, 'model-manifest.json'), `${JSON.stringify({
    version: 1,
    id: DEEPSEEK_V4_TOKENIZER_SPEC.id,
    repository: DEEPSEEK_V4_TOKENIZER_SPEC.repository,
    revision: DEEPSEEK_V4_TOKENIZER_SPEC.revision,
    counterId: DEEPSEEK_V4_TOKEN_COUNTER_ID,
    files: DEEPSEEK_V4_TOKENIZER_SPEC.files,
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
  return verification;
}

async function downloadVerifiedFile(
  fetchFn: typeof fetch,
  url: string,
  destination: string,
  file: TokenizerFileSpec,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const response = await fetchFn(url, { signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Tokenizer asset request failed: HTTP ${response.status} ${url}`);
    handle = await open(temporary, 'wx');
    const reader = response.body.getReader();
    const hash = createHash('sha256');
    let written = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      written += chunk.value.byteLength;
      if (written > file.bytes) throw new Error(`Tokenizer asset exceeded expected size: ${url}`);
      hash.update(chunk.value);
      await writeAll(handle, chunk.value);
      onBytes(written);
    }
    if (written !== file.bytes) throw new Error(`Tokenizer asset size mismatch for ${url}: ${written} != ${file.bytes}`);
    const digest = hash.digest('hex');
    if (digest !== file.sha256) throw new Error(`Tokenizer asset hash mismatch for ${url}`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await unlink(destination).catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
    await rename(temporary, destination);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten <= 0) throw new Error('Tokenizer asset write made no progress.');
    offset += result.bytesWritten;
  }
}

async function fileMatches(path: string, file: TokenizerFileSpec): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size === file.bytes && await hashFile(path) === file.sha256;
  } catch {
    return false;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function readJson(path: string): Promise<object> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Tokenizer asset is not a JSON object: ${path}`);
  }
  return parsed;
}

function tokenizerRevisionRoot(modelRootDir: string): string {
  return join(resolve(modelRootDir), DEEPSEEK_V4_TOKENIZER_SPEC.id, DEEPSEEK_V4_TOKENIZER_SPEC.revision);
}

function isDeepSeekV4ModelRef(modelRef: string): boolean {
  const normalized = modelRef.trim().toLowerCase();
  const slash = normalized.indexOf('/');
  return slash > 0
    && normalized.slice(0, slash) === 'deepseek'
    && isDeepSeekV4Model(normalized.slice(slash + 1));
}

function isDeepSeekV4Model(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === 'deepseek-v4-flash' || normalized === 'deepseek-v4-pro';
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

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
