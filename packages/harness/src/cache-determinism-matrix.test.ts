import { describe, expect, it } from 'vitest';
import type { ChatRequest, ToolSpec } from '@littlesheep/llm';
import type { CacheInvalidationReason, CacheObservation } from '@littlesheep/types';
import {
  buildCacheObservation,
  canonicalSerialize,
} from './cache-observability.js';

const key = 'cache-determinism-fixture-key';
const baseTools: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: 'Write a file',
      parameters: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } } },
    },
  },
];

type FixtureRequestOverrides = Partial<ChatRequest> & {
  runId?: string;
  time?: string;
  elapsed?: number;
  stable?: string;
};

function request(overrides: FixtureRequestOverrides = {}): ChatRequest {
  const {
    runId = 'run-a',
    time = '2026-09-03T00:00:00.000Z',
    elapsed = 0,
    stable = 'Stable policy v1',
    ...requestOverrides
  } = overrides;
  return {
    model: 'test/model',
    messages: [
      {
        role: 'system',
        content: [
          `${stable}\r\n`,
          '\n<!-- LITTLESHEEP_CACHE_BOUNDARY -->\n',
          `run=${runId}\n`,
          `time=${time}\n`,
          `elapsed=${elapsed}\n`,
        ].join(''),
      },
      { role: 'user', content: requestOverrides.user ?? 'same user input' },
    ],
    tools: requestOverrides.tools ?? baseTools,
    temperature: requestOverrides.temperature ?? 0,
    max_tokens: requestOverrides.max_tokens ?? 256,
    stream: requestOverrides.stream ?? true,
    ...requestOverrides,
  };
}

const basePromptComponents = {
  promptVersion: 'prompt-assembly-v3',
  systemPolicy: 'policy-v1',
  soul: 'soul-v1',
  userProfile: 'user-v1',
  memoryRevision: 'memory-revision-1',
  summary: 'summary-v1',
  locale: 'zh-HK/24',
} as const;

function observe(
  input: Partial<Parameters<typeof buildCacheObservation>[0]> & { request?: ChatRequest } = {},
): CacheObservation {
  const req = input.request ?? request();
  const { promptComponents: promptComponentOverrides, request: _ignoredRequest, ...rest } = input;
  return buildCacheObservation({
    request: req,
    provider: 'openai',
    model: req.model,
    requestKind: 'reply',
    requestIndex: 1,
    modelRequestId: 'model-request-1',
    sessionId: 'session-a',
    workspaceScope: 'C:\\Work\\LittleSheep',
    permissionPolicyId: 'research',
    key,
    promptComponents: { ...basePromptComponents, ...(promptComponentOverrides ?? {}) },
    ...rest,
  });
}

function comparable(observation: CacheObservation): unknown {
  return {
    stablePrefix: observation.stablePrefix,
    dynamicSuffix: observation.dynamicSuffix,
    normalizedRequest: observation.normalizedRequest,
    components: observation.components,
    promptComponents: observation.promptComponents,
    invalidationReasons: observation.invalidationReasons,
    primaryInvalidationReason: observation.primaryInvalidationReason,
  };
}

function changed(previous: CacheObservation, current: CacheObservation): string[] {
  const left = comparable(previous) as Record<string, unknown>;
  const right = comparable(current) as Record<string, unknown>;
  return Object.keys(left).filter((field) => canonicalSerialize(left[field]) !== canonicalSerialize(right[field]));
}

describe('CACHE-03/04/05 deterministic request matrix', () => {
  it('produces byte-identical evidence for 100 repeated assemblies', () => {
    const first = observe();
    const serialized = canonicalSerialize(comparable(first));
    for (let index = 0; index < 100; index += 1) {
      expect(canonicalSerialize(comparable(observe({
        requestIndex: index + 1,
        modelRequestId: `request-${index + 1}`,
      })))).toBe(serialized);
    }
  });

  it('is independent of concurrent completion order and restart identity', async () => {
    const inputs = Array.from({ length: 24 }, (_, index) => ({
      request: request({
        runId: `run-${index}`,
        time: `2026-09-03T00:00:${String(index).padStart(2, '0')}.000Z`,
        elapsed: index * 13,
        user: `user-${index}`,
      }),
      requestIndex: index + 1,
      modelRequestId: `request-${index + 1}`,
    }));
    const forward = await Promise.all(inputs.map((input) => Promise.resolve(observe(input))));
    const reverse = await Promise.all([...inputs].reverse().map((input) => Promise.resolve(observe(input))));
    for (let index = 0; index < inputs.length; index += 1) {
      const reversedIndex = inputs.length - index - 1;
      expect(canonicalSerialize(comparable(forward[index]!)))
        .toBe(canonicalSerialize(comparable(reverse[reversedIndex]!)));
    }

    const beforeRestart = observe({ requestIndex: 7, modelRequestId: 'before-restart' });
    const afterRestart = observe({ requestIndex: 7, modelRequestId: 'after-restart' });
    expect(canonicalSerialize(comparable(afterRestart))).toBe(canonicalSerialize(comparable(beforeRestart)));
  });

  it('keeps dynamic fields out of the stable prefix and identifies changed bytes', () => {
    const first = observe();
    const dynamic = observe({
      request: request({
        runId: 'run-b',
        time: '2026-09-03T03:04:05.000Z',
        elapsed: 9876,
        user: 'different user',
        temperature: 0.2,
        stream: false,
      }),
      previous: first,
      requestIndex: 2,
      modelRequestId: 'model-request-2',
    });
    expect(dynamic.stablePrefix.fingerprint).toBe(first.stablePrefix.fingerprint);
    expect(dynamic.dynamicSuffix.fingerprint).not.toBe(first.dynamicSuffix.fingerprint);
    expect(dynamic.normalizedRequest.fingerprint).not.toBe(first.normalizedRequest.fingerprint);
    expect(changed(first, dynamic)).toEqual([
      'dynamicSuffix',
      'normalizedRequest',
    ]);
    expect(dynamic.invalidationReasons).toEqual([]);
  });

  it.each([
    ['provider', { provider: 'deepseek' }, 'provider_changed', true],
    ['model', { model: 'test/other-model' }, 'model_changed', true],
    ['request kind', { requestKind: 'execute_final_reply' }, 'request_kind_changed', true],
    ['system policy', { promptComponents: { systemPolicy: 'policy-v2' }, request: request({ stable: 'Stable policy v2' }) }, 'system_policy_changed', true],
    ['soul', { promptComponents: { soul: 'soul-v2' }, request: request({ stable: 'Stable policy v2' }) }, 'soul_changed', true],
    ['user profile', { promptComponents: { userProfile: 'user-v2' }, request: request({ stable: 'Stable policy v2' }) }, 'user_profile_changed', true],
    ['memory revision', { promptComponents: { memoryRevision: 'memory-revision-2' } }, 'memory_revision_changed', false],
    ['summary', { promptComponents: { summary: 'summary-v2' } }, 'summary_compacted', false],
    ['locale', { promptComponents: { locale: 'en-US/12' } }, 'locale_changed', false],
  ] as const)('reports %s with an explicit invalidation boundary', (_label, mutation, reason, prefixChanges) => {
    const first = observe();
    const current = observe({ previous: first, requestIndex: 2, modelRequestId: 'request-2', ...mutation });
    if (prefixChanges) expect(current.stablePrefix.fingerprint).not.toBe(first.stablePrefix.fingerprint);
    else expect(current.stablePrefix.fingerprint).toBe(first.stablePrefix.fingerprint);
    expect(current.invalidationReasons).toContain(reason as CacheInvalidationReason);
    expect(current.primaryInvalidationReason).toBe(reason);
  });

  it('treats Windows path case as the same path but keeps scopes isolated', () => {
    const upper = observe({ workspaceScope: 'C:\\Work\\LittleSheep' });
    const lower = observe({ workspaceScope: 'c:/work/littlesheep' });
    expect(lower.scope.workspaceDigest).toBe(upper.scope.workspaceDigest);
    expect(lower.stablePrefix.fingerprint).toBe(upper.stablePrefix.fingerprint);

    const otherSession = observe({ sessionId: 'session-b' });
    const otherWorkspace = observe({ workspaceScope: 'D:\\Other' });
    const otherPermission = observe({ permissionPolicyId: 'restricted' });
    expect(otherSession.stablePrefix.fingerprint).not.toBe(upper.stablePrefix.fingerprint);
    expect(otherWorkspace.stablePrefix.fingerprint).not.toBe(upper.stablePrefix.fingerprint);
    expect(otherPermission.stablePrefix.fingerprint).not.toBe(upper.stablePrefix.fingerprint);
  });

  it('canonicalizes tool order but invalidates additions and schema edits', () => {
    const first = observe({ request: request({ tools: baseTools }) });
    const reordered = observe({
      request: request({ tools: [...baseTools].reverse() }),
      previous: first,
      requestIndex: 2,
      modelRequestId: 'request-2',
    });
    expect(reordered.stablePrefix.fingerprint).toBe(first.stablePrefix.fingerprint);
    expect(reordered.invalidationReasons).toEqual([]);

    const added = observe({
      request: request({ tools: [...baseTools, {
        type: 'function',
        function: { name: 'glob', description: 'List files', parameters: { type: 'object' } },
      }] }),
      previous: first,
      requestIndex: 3,
      modelRequestId: 'request-3',
    });
    expect(added.stablePrefix.fingerprint).not.toBe(first.stablePrefix.fingerprint);
    expect(added.invalidationReasons).toEqual(['tool_schema_changed']);

    const edited = observe({
      request: request({ tools: baseTools.map((tool) => tool.function.name === 'read'
        ? { ...tool, function: { ...tool.function, description: 'Read a file safely' } }
        : tool) }),
      previous: first,
      requestIndex: 4,
      modelRequestId: 'request-4',
    });
    expect(edited.stablePrefix.fingerprint).not.toBe(first.stablePrefix.fingerprint);
    expect(edited.invalidationReasons).toEqual(['tool_schema_changed']);
  });
});
