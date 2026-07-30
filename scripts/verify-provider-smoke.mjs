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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supportedChecks = new Set(['chat', 'continuity', 'tool', 'abort']);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await app.whenReady();

  const branding = await loadBranding(join(repoRoot, 'branding.config.json'));
  const dataDir = resolveDataDir(branding);
  const inheritedEnvironment = { ...process.env };
  const storedCredentialState = await loadEncryptedKeys(dataDir);
  const storedKeys = storedCredentialState.keys;
  injectKeys(storedKeys);

  const config = await loadConfig({ dataDir });
  const provider = getProvider(config, args.provider);
  if (!provider) throw new Error(`Provider ${args.provider} is not configured.`);

  const model = args.model ?? defaultModel(config, provider.id, provider.models ?? []);
  if (!model) throw new Error(`Provider ${provider.id} has no configured model.`);
  const apiKey = resolveApiKey(provider.apiKey);
  if (!apiKey) throw new Error(`Provider ${provider.id} has no usable API key.`);

  if (args.credentialDiagnostics) {
    const envVar = provider.apiKey?.startsWith('$') ? provider.apiKey.slice(1) : undefined;
    const inheritedCredential = envVar ? inheritedEnvironment[envVar] : undefined;
    console.log(JSON.stringify({
      provider: provider.id,
      source: envVar && Object.hasOwn(storedKeys, envVar)
        ? 'keychain'
        : envVar && inheritedCredential
          ? 'environment'
          : provider.apiKey && !envVar
            ? 'literal'
            : 'none',
      credential: inspectCredential(apiKey),
      keychain: envVar
        ? {
            entryPresent: storedCredentialState.entryNames.includes(envVar),
            decryptable: Object.hasOwn(storedKeys, envVar),
          }
        : { entryPresent: false, decryptable: false },
      inheritedEnvironment: inheritedCredential
        ? {
            present: true,
            matchesResolvedCredential: inheritedCredential === apiKey,
            credential: inspectCredential(inheritedCredential),
          }
        : { present: false },
    }));
    return 0;
  }

  const client = createLlmClient({
    baseURL: provider.baseURL,
    apiKey,
    timeoutSeconds: args.timeoutSeconds,
  }, {
    retry: { maxAttempts: 1 },
  });
  const reasoning = resolveProviderReasoningRequest(provider.id, model, args.reasoning);
  const requestOptions = {
    reasoning_effort: reasoning.reasoningEffort,
    thinking: reasoning.thinking
      ? {
          type: reasoning.thinking.type,
          clear_thinking: reasoning.thinking.clearThinking,
        }
      : undefined,
  };

  const results = [];
  for (const check of args.checks) {
    if (check === 'chat') results.push(await runChat(client, provider.id, model, requestOptions));
    if (check === 'continuity') results.push(await runContinuity(client, provider.id, model, requestOptions));
    if (check === 'tool') results.push(await runTool(client, provider.id, model, requestOptions));
    if (check === 'abort') results.push(await runAbort(client, provider.id, model, requestOptions));
  }

  for (const result of results) console.log(JSON.stringify(result));
  return results.every((result) => result.ok) ? 0 : 1;
}

async function runContinuity(client, provider, model, requestOptions) {
  const startedAt = Date.now();
  try {
    const response = await client.chat({
      model,
      messages: [
        {
          role: 'system',
          content: [
            'Continue the supplied conversation unless the user changes topics.',
            'Resolve shorthand and numeric references from recent messages before asking for repeated information.',
            'A later explicit user correction supersedes an earlier conflicting assistant claim within the same topic.',
            'Answer the final user message naturally in Chinese.',
          ].join(' '),
        },
        { role: 'user', content: '介绍一下DBV-152这辆车吧。' },
        { role: 'assistant', content: 'DBV-152 是一辆 X 级坦克歼击车，使用 152 mm 主炮，单发伤害是 750。' },
        { role: 'user', content: '单发是800啊。' },
        { role: 'assistant', content: '明白了，已更正：DBV-152 的单发伤害是 800。' },
        { role: 'user', content: '假如你拥有了152，会怎么做呢？' },
      ],
      max_tokens: 768,
      ...requestOptions,
    });
    const content = response.content.trim();
    const resolvesVehicle = /DBV|坦克|TD|歼击|车辆|装甲|主炮|单发|伏击|支援|转场/u.test(content);
    const asksForRepeatedSubject = /152.{0,16}(是什么|指什么|具体指|什么意思)|请.{0,12}(解释|说明).{0,12}152/u.test(content);
    return {
      check: 'continuity',
      ok: content.length > 0 && resolvesVehicle && !asksForRepeatedSubject,
      provider,
      model,
      finishReason: response.finishReason,
      resolvedReference: resolvesVehicle,
      askedForRepeatedSubject,
      contentCharacters: content.length,
      usage: sanitizeUsage(response.usage),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return failedResult('continuity', provider, model, startedAt, error);
  }
}

async function runChat(client, provider, model, requestOptions) {
  const startedAt = Date.now();
  try {
    const response = await client.chat({
      model,
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      max_tokens: 256,
      ...requestOptions,
    });
    return {
      check: 'chat',
      ok: response.content.trim().length > 0,
      provider,
      model,
      finishReason: response.finishReason,
      contentCharacters: response.content.length,
      reasoningCharacters: response.reasoningContent?.length ?? 0,
      usage: sanitizeUsage(response.usage),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return failedResult('chat', provider, model, startedAt, error);
  }
}

async function runTool(client, provider, model, requestOptions) {
  const startedAt = Date.now();
  const messages = [{
    role: 'user',
    content: 'Call the provider_smoke_probe tool exactly once with value set to ok. Do not answer directly.',
  }];
  const tools = [{
    type: 'function',
    function: {
      name: 'provider_smoke_probe',
      description: 'Returns the supplied smoke-test value.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string', enum: ['ok'] } },
        required: ['value'],
        additionalProperties: false,
      },
    },
  }];

  try {
    const first = await client.chat({
      model,
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: 512,
      ...requestOptions,
    });
    if (first.toolCalls.length === 0) {
      return {
        check: 'tool',
        ok: false,
        provider,
        model,
        finishReason: first.finishReason,
        reason: 'Provider returned no tool call.',
        usage: sanitizeUsage(first.usage),
        durationMs: Date.now() - startedAt,
      };
    }

    const continuationMessages = [
      ...messages,
      {
        role: 'assistant',
        content: first.content,
        reasoning_content: first.reasoningContent,
        tool_calls: first.toolCalls,
      },
      ...first.toolCalls.map((call) => ({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify({ value: 'ok' }),
      })),
    ];
    const second = await client.chat({
      model,
      messages: continuationMessages,
      tools,
      tool_choice: 'auto',
      max_tokens: 256,
      ...requestOptions,
    });
    return {
      check: 'tool',
      ok: second.content.trim().length > 0,
      provider,
      model,
      firstFinishReason: first.finishReason,
      continuationFinishReason: second.finishReason,
      toolNames: first.toolCalls.map((call) => call.function.name),
      reasoningReplayed: Boolean(first.reasoningContent),
      contentCharacters: second.content.length,
      usage: {
        first: sanitizeUsage(first.usage),
        continuation: sanitizeUsage(second.usage),
      },
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return failedResult('tool', provider, model, startedAt, error);
  }
}

async function runAbort(client, provider, model, requestOptions) {
  const startedAt = Date.now();
  const controller = new AbortController();
  let receivedChunk = false;
  const fallback = setTimeout(() => controller.abort(), 1_500);
  try {
    await client.chatStream({
      model,
      messages: [{
        role: 'user',
        content: 'Think carefully and produce a detailed numbered analysis of twelve independent considerations.',
      }],
      max_tokens: 2_048,
      stream: true,
      signal: controller.signal,
      ...requestOptions,
    }, () => {
      receivedChunk = true;
      controller.abort();
    });
    return {
      check: 'abort',
      ok: false,
      provider,
      model,
      receivedChunk,
      reason: 'Request completed before cancellation took effect.',
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      check: 'abort',
      ok: controller.signal.aborted,
      provider,
      model,
      receivedChunk,
      outcome: controller.signal.aborted ? 'aborted' : 'failed_before_abort',
      errorKind: errorName(error),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(fallback);
  }
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
    } else {
      values.set(current.slice(2), 'true');
    }
  }

  const checks = (values.get('checks') ?? 'chat,tool,abort')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const check of checks) {
    if (!supportedChecks.has(check)) throw new Error(`Unknown provider check: ${check}`);
  }

  const reasoning = values.get('reasoning') ?? 'high';
  if (!['auto', 'low', 'medium', 'high', 'ultra'].includes(reasoning)) {
    throw new Error(`Unknown reasoning level: ${reasoning}`);
  }
  const timeoutSeconds = Number(values.get('timeout-seconds') ?? 45);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 300) {
    throw new Error('timeout-seconds must be between 1 and 300.');
  }

  return {
    provider: values.get('provider') ?? 'deepseek',
    model: values.get('model'),
    reasoning,
    checks,
    timeoutSeconds,
    credentialDiagnostics: values.has('credential-diagnostics'),
  };
}

function inspectCredential(value) {
  const trimmed = value.trim();
  const wrappingQuotes = trimmed.length >= 2 && (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  );
  const unquoted = wrappingQuotes ? trimmed.slice(1, -1).trim() : trimmed;
  const bearerPrefix = /^Bearer\s+/i.test(unquoted);
  const normalized = unquoted.replace(/^Bearer\s+/i, '').trim();
  return {
    rawLength: value.length,
    normalizedLength: normalized.length,
    outerWhitespace: value !== trimmed,
    wrappingQuotes,
    bearerPrefix,
    whitespaceAfterNormalization: /\s/.test(normalized),
    controlCharactersAfterNormalization: [...normalized]
      .some((character) => /[\u0000-\u001f\u007f]/.test(character)),
    prefixClass: normalized.startsWith('sk-') ? 'sk-*' : 'other',
  };
}

async function loadEncryptedKeys(dataDir) {
  let store;
  try {
    store = JSON.parse(await readFile(join(dataDir, 'config', 'keys.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { keys: {}, entryNames: [] };
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
  return { keys, entryNames: Object.keys(store) };
}

function injectKeys(keys) {
  for (const [name, value] of Object.entries(keys)) process.env[name] = value;
}

function defaultModel(config, providerId, models) {
  const configured = config.agents.defaults.model;
  const prefix = `${providerId}/`;
  return configured.startsWith(prefix) ? configured.slice(prefix.length) : models[0];
}

function sanitizeUsage(usage) {
  if (!usage) return undefined;
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    cachedPromptTokens: usage.cachedPromptTokens,
    reasoningTokens: usage.reasoningTokens,
  };
}

function failedResult(check, provider, model, startedAt, error) {
  return {
    check,
    ok: false,
    provider,
    model,
    ...safeErrorDetails(error),
    durationMs: Date.now() - startedAt,
  };
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
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/api key:\s*\S+/gi, 'api key: [redacted]')
    .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]')
    .replace(/\*{2,}[A-Za-z0-9]{2,}/g, '[redacted-key]')
    .replace(/[A-Za-z0-9+/=_-]{48,}/g, '[redacted-token]')
    .slice(0, 300);
}

function errorName(error) {
  if (error instanceof Error) return error.name || 'Error';
  return typeof error;
}

function isPlausibleSecret(value) {
  return value.length >= 8 && value.length <= 1_024 && /^[\x20-\x7E]+$/.test(value);
}

main()
  .then((code) => app.exit(code))
  .catch((error) => {
    console.error(JSON.stringify({ check: 'setup', ok: false, ...safeErrorDetails(error) }));
    app.exit(1);
  });
