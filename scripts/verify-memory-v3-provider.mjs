import { app, safeStorage } from 'electron';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBranding, resolveDataDir } from '../packages/branding/dist/index.js';
import {
  getProvider,
  loadConfig,
  resolveApiKey,
  resolveProviderReasoningRequest,
} from '../packages/config/dist/index.js';
import { createLlmClient } from '../packages/llm/dist/index.js';
import { runMemoryV3ProviderAcceptance } from './lib/memory-v3-provider-acceptance.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await app.whenReady();
  const branding = await loadBranding(join(repoRoot, 'branding.config.json'));
  const sourceDataDir = resolveDataDir(branding);
  injectKeys(await loadEncryptedKeys(sourceDataDir));
  const config = await loadConfig({ dataDir: sourceDataDir });
  const providerId = args.provider ?? configuredProviderId(config.agents.defaults.model);
  const provider = getProvider(config, providerId);
  if (!provider) throw new Error(`Provider ${providerId} is not configured.`);
  const model = args.model ?? configuredModel(config.agents.defaults.model, provider.id) ?? provider.models?.[0];
  if (!model) throw new Error(`Provider ${provider.id} has no configured model.`);
  const apiKey = resolveApiKey(provider.apiKey);
  if (!apiKey) throw new Error(`Provider ${provider.id} has no usable API key.`);

  const providerPreflight = await verifyProviderPreflight({
    provider,
    model,
    apiKey,
    reasoning: args.reasoning,
    timeoutSeconds: args.timeoutSeconds,
  });

  const result = await runMemoryV3ProviderAcceptance({
    config,
    branding,
    sourceDataDir,
    providerId: provider.id,
    modelRef: `${provider.id}/${model}`,
    reasoning: args.reasoning,
    timeoutMs: args.timeoutSeconds * 1_000,
  });
  console.log(JSON.stringify({ ...result, providerPreflight }, null, 2));
  return 0;
}

async function verifyProviderPreflight(options) {
  const reasoning = resolveProviderReasoningRequest(
    options.provider.id,
    options.model,
    options.reasoning,
  );
  const client = createLlmClient({
    baseURL: options.provider.baseURL,
    apiKey: options.apiKey,
    timeoutSeconds: Math.min(options.timeoutSeconds, 60),
  }, {
    retry: { maxAttempts: 1 },
  });
  const response = await client.chat({
    model: options.model,
    messages: [{
      role: 'user',
      content: 'This is an isolated provider preflight. Reply with only OK.',
    }],
    max_tokens: 64,
    reasoning_effort: reasoning.reasoningEffort,
    thinking: reasoning.thinking ? {
      type: reasoning.thinking.type,
      clear_thinking: reasoning.thinking.clearThinking,
    } : undefined,
  });
  if (!response.content.trim()) throw new Error(`Provider ${options.provider.id} returned an empty preflight reply.`);
  if (!response.usage || response.usage.promptTokens <= 0) {
    throw new Error(`Provider ${options.provider.id} did not return authoritative preflight usage.`);
  }
  return {
    finishReason: response.finishReason,
    promptTokens: response.usage.promptTokens,
    completionTokens: response.usage.completionTokens,
    totalTokens: response.usage.totalTokens,
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--') continue;
    if (!current?.startsWith('--')) continue;
    const equals = current.indexOf('=');
    if (equals > 2) {
      values.set(current.slice(2, equals), current.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      values.set(current.slice(2), next);
      index += 1;
    }
  }
  const reasoning = values.get('reasoning') ?? 'medium';
  if (!['auto', 'low', 'medium', 'high', 'ultra'].includes(reasoning)) {
    throw new Error(`Unknown reasoning level: ${reasoning}`);
  }
  const timeoutSeconds = Number(values.get('timeout-seconds') ?? 180);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 900) {
    throw new Error('timeout-seconds must be between 30 and 900.');
  }
  return {
    provider: values.get('provider'),
    model: values.get('model'),
    reasoning,
    timeoutSeconds,
  };
}

async function loadEncryptedKeys(dataDir) {
  let store;
  try {
    store = JSON.parse(await readFile(join(dataDir, 'config', 'keys.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Unable to read encrypted provider keys: ${errorName(error)}`);
  }
  const keys = {};
  for (const [name, encoded] of Object.entries(store)) {
    if (typeof encoded !== 'string') continue;
    const encrypted = Buffer.from(encoded, 'base64');
    let plaintext;
    if (safeStorage.isEncryptionAvailable()) {
      try {
        plaintext = safeStorage.decryptString(encrypted);
      } catch {
        const fallback = encrypted.toString('utf8');
        if (isPlausibleSecret(fallback)) plaintext = fallback;
      }
    } else {
      const fallback = encrypted.toString('utf8');
      if (isPlausibleSecret(fallback)) plaintext = fallback;
    }
    if (plaintext) keys[name] = plaintext;
  }
  return keys;
}

function injectKeys(keys) {
  for (const [name, value] of Object.entries(keys)) process.env[name] = value;
}

function configuredProviderId(modelRef) {
  const slash = modelRef.indexOf('/');
  return slash > 0 ? modelRef.slice(0, slash) : 'deepseek';
}

function configuredModel(modelRef, providerId) {
  const prefix = `${providerId}/`;
  return modelRef.startsWith(prefix) ? modelRef.slice(prefix.length) : undefined;
}

function safeErrorDetails(error) {
  if (!(error instanceof Error)) return { errorKind: typeof error };
  const details = {
    errorKind: error.name || 'Error',
    errorMessage: redactErrorMessage(error.message),
  };
  if (typeof error.status === 'number') details.status = error.status;
  if (typeof error.retryable === 'boolean') details.retryable = error.retryable;
  return details;
}

function redactErrorMessage(message) {
  return message
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/api key:\s*\S+/giu, 'api key: [redacted]')
    .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/gu, '[redacted-key]')
    .replace(/\*{2,}[A-Za-z0-9]{2,}/gu, '[redacted-key]')
    .replace(/[A-Za-z0-9+/=_-]{48,}/gu, '[redacted-token]')
    .slice(0, 400);
}

function errorName(error) {
  return error instanceof Error ? error.name || 'Error' : typeof error;
}

function isPlausibleSecret(value) {
  return value.length >= 8 && value.length <= 1_024 && /^[\x20-\x7E]+$/u.test(value);
}

main()
  .then((code) => app.exit(code))
  .catch((error) => {
    console.error(JSON.stringify({ check: 'memory-v3-provider', ok: false, ...safeErrorDetails(error) }));
    app.exit(1);
  });
