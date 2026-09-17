import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG, type Config } from '@littlesheep/config';
import type { ChatRequest, ChatResponse, LlmClient } from '@littlesheep/llm';
import type {
  AgentTool,
  FetchedDocument,
  SearchResponse,
  WebRetrievalRuntimePort,
} from '@littlesheep/types';
import {
  SearchProviderRegistry,
  type SearchProvider,
  type WebCache,
} from '@littlesheep/web';
import { createRunner } from './runner.js';

const PUBLIC_URL = 'https://93.184.216.34/article';
let dataDir: string;
const runners: Array<{ shutdown(): Promise<void> }> = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ls-web-runtime-'));
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
});

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.shutdown().catch(() => undefined);
  delete process.env.LITTLESHEEP_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function text(content: string): ChatResponse {
  return { content, toolCalls: [], finishReason: 'stop' };
}

function toolCall(callId: string): ChatResponse {
  return {
    content: '',
    finishReason: 'tool_calls',
    toolCalls: [{ id: callId, type: 'function', function: { name: 'web_runtime_probe', arguments: '{}' } }],
  };
}

function scriptedWebLlm(): LlmClient {
  let toolCallCount = 0;
  let finalReplyCount = 0;
  const chat = vi.fn(async (request: ChatRequest) => {
    // Read every message: volatile Context sections travel after the system
    // prompt so the Provider's cacheable prefix stays stable.
    const system = request.messages.map((message) => String(message.content)).join('\n');
    if (system.includes('Choose the next LittleSheep activity')) {
      return text('{"activity":"execute","confidence":0.99,"reason":"run the requested probe"}');
    }
    if (system.includes('You are the DECIDE stage')) {
      return text(JSON.stringify({
        assessment: {
          userNeed: 'run the web runtime probe',
          complexity: 'simple',
          goal: 'run the web runtime probe',
          successCriteria: ['the probe returns a runtime fact'],
          missingInfo: [],
          needsClarification: false,
          requiresTaskBook: true,
        },
        taskBook: {
          goal: 'run the web runtime probe',
          complexity: 'simple',
          successCriteria: ['the probe returns a runtime fact'],
          steps: [{
            id: 'step-1',
            title: 'Probe web runtime',
            description: 'Run the web runtime probe once.',
            tools: ['web_runtime_probe'],
            requiresApproval: false,
            acceptanceCriteria: ['the tool returns a result'],
            expectedOutput: 'runtime probe result',
          }],
        },
      }));
    }
    if (system.includes('You are the final response assembler')) {
      finalReplyCount += 1;
      return text(`Web runtime probe ${finalReplyCount} complete.`);
    }
    if (system.includes('You are the VERIFY stage')) {
      return text('{"verdict":"pass","reason":"the runtime probe produced positive tool evidence","failedStepIds":[],"usedMemoryAtomIds":[]}');
    }
    if (system.includes('You are the EVOLVE stage')) {
      return text('{"memories":[],"reconciliations":[],"reparents":[],"subtreeMoves":[],"revisions":[],"corrections":[],"createSkill":null}');
    }
    if (system.includes('You are the CAPTURE stage')) {
      return text('{"observations":[]}');
    }
    if (request.tools?.some((tool) => tool.function.name === 'web_runtime_probe')) {
      if (request.messages.some((message) => message.role === 'tool')) {
        return text('Web runtime probe step completed.');
      }
      toolCallCount += 1;
      return toolCall(`web-call-${toolCallCount}`);
    }
    return text('Web runtime probe completed.');
  });
  return {
    chat,
    chatStream: vi.fn(async (request, onDelta) => {
      const response = await chat(request);
      onDelta({ type: 'done', finishReason: response.finishReason });
      return response;
    }),
    embed: vi.fn(async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } })),
  };
}

function scriptedBuiltinWebLlm(observedBodies: string[]): LlmClient {
  let citationId = '';
  const chat = vi.fn(async (request: ChatRequest) => {
    // Read every message: volatile Context sections travel after the system
    // prompt so the Provider's cacheable prefix stays stable.
    const system = request.messages.map((message) => String(message.content)).join('\n');
    if (system.includes('Choose the next LittleSheep activity')) {
      return text('{"activity":"execute","confidence":0.99,"reason":"retrieve current public evidence"}');
    }
    if (system.includes('# Read-only tool decision')) {
      expect(system).toContain('web_search');
      expect(system).toContain('web_fetch');
      expect(system).not.toContain('glob tool');
      return text(JSON.stringify({
        tool: 'web_search',
        input: { query: 'current public docs', maxResults: 1 },
        summary: 'Retrieve one current public source',
        successCriterion: 'Return a Runtime citation backed by fetched public content',
      }));
    }
    if (system.includes('You are the DECIDE stage')) {
      return text(JSON.stringify({
        assessment: {
          userNeed: 'retrieve current public evidence', complexity: 'standard',
          goal: 'search and fetch a current public source',
          successCriteria: ['the source is searched, fetched and cited'], missingInfo: [],
          needsClarification: false, requiresTaskBook: true,
        },
        taskBook: {
          goal: 'search and fetch a current public source', complexity: 'standard',
          successCriteria: ['the source is searched, fetched and cited'],
          steps: [{
            id: 'web-step', title: 'Retrieve public source',
            description: 'Search then fetch the selected public source.',
            tools: ['web_search', 'web_fetch'], requiresApproval: false,
            acceptanceCriteria: ['one Runtime citation is returned'], expectedOutput: 'citation-backed result',
          }],
        },
      }));
    }
    if (system.includes('You are the final response assembler')) {
      return text(`Current source verified [citation:${citationId}].`);
    }
    if (system.includes('You are the VERIFY stage')) {
      return text('{"verdict":"pass","reason":"the Runtime citation is present","failedStepIds":[],"usedMemoryAtomIds":[]}');
    }
    if (system.includes('You are the EVOLVE stage')) {
      return text('{"memories":[],"reconciliations":[],"reparents":[],"subtreeMoves":[],"revisions":[],"corrections":[],"createSkill":null}');
    }
    if (system.includes('You are the CAPTURE stage')) return text('{"observations":[]}');

    const toolMessages = request.messages.filter((message) => message.role === 'tool');
    if (toolMessages.length === 0 && request.tools?.some((tool) => tool.function.name === 'web_search')) {
      return {
        content: '', finishReason: 'tool_calls',
        toolCalls: [{
          id: 'builtin-search', type: 'function',
          function: { name: 'web_search', arguments: JSON.stringify({ query: 'current public docs', maxResults: 1 }) },
        }],
      } satisfies ChatResponse;
    }
    if (toolMessages.length === 1) {
      const searchEvidence = String(toolMessages[0]!.content);
      const outer = JSON.parse(searchEvidence) as { output?: string };
      const modelEvidence = JSON.parse(String(outer.output ?? '{}')) as {
        results?: Array<{ citationId?: string }>;
      };
      citationId = modelEvidence.results?.[0]?.citationId ?? '';
      expect(searchEvidence).toContain('Runner cached page');
      return {
        content: '', finishReason: 'tool_calls',
        toolCalls: [{
          id: 'builtin-fetch', type: 'function',
          function: { name: 'web_fetch', arguments: JSON.stringify({ url: PUBLIC_URL, citationId }) },
        }],
      } satisfies ChatResponse;
    }
    if (toolMessages.length >= 2) {
      const fetchedEvidence = String(toolMessages.at(-1)!.content);
      observedBodies.push(fetchedEvidence);
      expect(fetchedEvidence).toContain('This body must not enter the durable evidence projection.');
      expect(fetchedEvidence).toContain('externalUntrusted');
      return text(`Step verified [citation:${citationId}].`);
    }
    return text('Unexpected built-in Web flow.');
  });
  return {
    chat,
    chatStream: vi.fn(async (request, onDelta) => {
      const response = await chat(request);
      onDelta({ type: 'done', finishReason: response.finishReason });
      return response;
    }),
    embed: vi.fn(async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } })),
  };
}

function enabledConfig(): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  config.web.enabled = true;
  config.web.readMode = 'public_anonymous';
  config.web.defaultProvider = 'fake';
  config.web.providers = [{ id: 'fake', type: 'tavily-search-v1', apiKeyRef: '$PATH', options: {} }];
  config.web.maxQueriesPerRun = 1;
  config.web.maxFetchesPerRun = 1;
  config.web.maxConcurrentRequests = 1;
  return config;
}

function document(): FetchedDocument {
  return {
    version: 1,
    requestedUrl: PUBLIC_URL,
    finalUrl: PUBLIC_URL,
    redirectChain: [],
    status: 200,
    contentType: 'text/html; charset=utf-8',
    title: 'Runner cached page',
    extractor: 'readability',
    content: 'This body must not enter the durable evidence projection.',
    contentHash: 'sha256:runner-cache',
    fetchedAt: '2026-08-29T00:00:00.000Z',
    cached: false,
    truncated: false,
    externalUntrusted: true,
    warnings: [],
  };
}

describe('Runner per-run web retrieval assembly', () => {
  it('runs the real built-in search/fetch chain while keeping bodies and raw queries out of durable state', async () => {
    const providerSearch = vi.fn(async (request: Parameters<SearchProvider['search']>[0], context: Parameters<SearchProvider['search']>[1]): Promise<SearchResponse> => ({
      version: 1,
      provider: 'fake',
      query: request.query,
      results: [{
        rank: 1,
        title: 'Runner cached page',
        url: PUBLIC_URL,
        canonicalUrl: PUBLIC_URL,
        citationId: context.citationIdFor!(PUBLIC_URL, 1),
        sourceStatus: 'search_result',
      }],
      fetchedAt: '2026-08-29T00:00:00.000Z',
      cached: false,
      partial: false,
      warnings: [],
    }));
    const provider: SearchProvider = {
      id: 'fake', displayName: 'Fake',
      capabilities: { search: true, recency: true, domains: true, language: true, citations: true },
      search: providerSearch,
    };
    const cacheGet = vi.fn(async () => document());
    const cache: WebCache = {
      get: cacheGet,
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      stats: () => ({ entries: 1, bytes: 100, hits: cacheGet.mock.calls.length, misses: 0 }),
    };
    const observedBodies: string[] = [];
    const runner = await createRunner({
      config: enabledConfig(), branding: DEFAULT_BRANDING, model: 'test/model',
      llm: scriptedBuiltinWebLlm(observedBodies), approve: async () => true,
      bootstrapDir: dataDir, skillsDirs: [],
    });
    runners.push(runner);
    runner.infra.webProviders = new SearchProviderRegistry([provider]);
    runner.infra.webCache = cache;

    const result = await runner.run({ runId: 'runner-builtin-web', text: 'retrieve one current public source' });
    const replay = await runner.replay(result.runId);

    expect(result.status).toBe('ok');
    expect(providerSearch).toHaveBeenCalledTimes(1);
    expect(
      cacheGet.mock.calls.length,
      JSON.stringify({
        status: result.status,
        error: result.error,
        reply: result.reply,
        toolInvocations: result.toolInvocations,
        messages: result.messages,
        webEvidence: result.webEvidence,
        observedBodies,
      }),
    ).toBe(1);
    expect(observedBodies).toHaveLength(1);
    expect(result.webEvidence).toMatchObject({ citationCount: 1, documentCount: 1, completeness: 'complete' });
    expect(replay?.webEvidence?.citationIds).toEqual(result.webEvidence?.citationIds);
    expect(replay?.webEvidence?.citations).toEqual(result.webEvidence?.citations);
    const durable = JSON.stringify({ result, replay });
    expect(durable).not.toContain('This body must not enter the durable evidence projection.');
    expect(durable).not.toContain('current public docs');
    expect(durable).not.toContain('modelOutput');
    expect(durable).toContain(result.webEvidence!.citationIds[0]!);
  });

  it('injects a fresh runtime per run, shares only cache, persists projection and disposes both runtimes', async () => {
    const providerRunIds: string[] = [];
    const provider: SearchProvider = {
      id: 'fake',
      displayName: 'Fake',
      capabilities: { search: true, recency: true, domains: true, language: true, citations: true },
      async search(request, context): Promise<SearchResponse> {
        providerRunIds.push(request.runId);
        return {
          version: 1,
          provider: 'fake',
          query: request.query,
          results: [{
            rank: 1,
            title: 'Runner cached page',
            url: PUBLIC_URL,
            canonicalUrl: PUBLIC_URL,
            citationId: context.citationIdFor!(PUBLIC_URL, 1),
            sourceStatus: 'search_result',
          }],
          fetchedAt: '2026-08-29T00:00:00.000Z',
          cached: false,
          partial: false,
          warnings: [],
        };
      },
    };
    const cacheGet = vi.fn(async () => document());
    const cache: WebCache = {
      get: cacheGet,
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      stats: () => ({ entries: 1, bytes: 100, hits: cacheGet.mock.calls.length, misses: 0 }),
    };
    const observations: Array<{
      runId: string;
      runtime: WebRetrievalRuntimePort;
      citationId: string;
      cached: boolean;
    }> = [];
    const probe: AgentTool = {
      name: 'web_runtime_probe',
      description: 'Exercise the run-owned web retrieval port.',
      inputSchema: { parse: (input) => input, jsonSchema: { type: 'object', additionalProperties: false } },
      async execute(_input, context) {
        if (!context.webRetrieval) return { callId: '', ok: false, error: 'web runtime missing' };
        const search = await context.webRetrieval.search({
          query: 'runner probe',
          maxResults: 1,
          runId: 'caller-must-not-control-this',
        }, context.signal);
        const citationId = search.results[0]!.citationId;
        const fetched = await context.webRetrieval.fetch({ url: PUBLIC_URL, citationId }, context.signal);
        await context.webEvidenceSink?.record(context.webRetrieval.evidence());
        observations.push({ runId: context.runId, runtime: context.webRetrieval, citationId, cached: fetched.cached });
        return { callId: '', ok: true, output: `citation=${citationId}` };
      },
    };
    const runner = await createRunner({
      config: enabledConfig(),
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: scriptedWebLlm(),
      approve: async () => true,
      bootstrapDir: dataDir,
      skillsDirs: [],
    });
    runners.push(runner);
    runner.infra.webProviders = new SearchProviderRegistry([provider]);
    runner.infra.webCache = cache;

    const first = await runner.run({ runId: 'runner-web-first', text: 'run first runtime probe', additionalTools: [probe] });
    const second = await runner.run({ runId: 'runner-web-second', text: 'run second runtime probe', additionalTools: [probe] });

    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
    expect(providerRunIds).toEqual([first.runId, second.runId]);
    expect(cacheGet).toHaveBeenCalledTimes(2);
    expect(observations).toHaveLength(2);
    expect(observations.every((item) => item.cached)).toBe(true);
    expect(observations[0]!.citationId).not.toBe(observations[1]!.citationId);
    expect(first.webEvidence).toMatchObject({ providerId: 'fake', citationCount: 1, documentCount: 1, cached: true });
    expect(second.webEvidence).toMatchObject({ providerId: 'fake', citationCount: 1, documentCount: 1, cached: true });
    expect(await runner.replay(first.runId)).toMatchObject({ webEvidence: first.webEvidence });
    expect(JSON.stringify(await runner.replay(first.runId))).not.toContain('This body must not enter');
    for (const observation of observations) {
      await expect(observation.runtime.search({ query: 'after run', maxResults: 1, runId: observation.runId }))
        .rejects.toMatchObject({ kind: 'web_fetch_cancelled' });
    }
  });

  it.each([
    ['disabled', (() => {
      const config = enabledConfig();
      config.web.enabled = false;
      return config;
    })()],
    ['unconfigured', (() => {
      const config = enabledConfig();
      config.web.providers = [];
      return config;
    })()],
  ] as const)('keeps the runtime absent and performs zero provider calls when %s', async (_label, config) => {
    const providerSearch = vi.fn(async () => { throw new Error('must not execute'); });
    const provider: SearchProvider = {
      id: 'fake',
      displayName: 'Fake',
      capabilities: { search: true, recency: true, domains: true, language: true, citations: true },
      search: providerSearch,
    };
    const seen: boolean[] = [];
    const reservedWebExecute = vi.fn(async () => ({ callId: '', ok: true, output: 'must-not-run' }));
    const reservedWebTool: AgentTool = {
      name: 'web_search',
      description: 'A run-scoped attempt to restore a reserved Web capability.',
      inputSchema: { parse: (input) => input, jsonSchema: { type: 'object' } },
      execute: reservedWebExecute,
    };
    const probe: AgentTool = {
      name: 'web_runtime_probe',
      description: 'Report whether a web runtime was injected.',
      inputSchema: { parse: (input) => input, jsonSchema: { type: 'object', additionalProperties: false } },
      async execute(_input, context) {
        seen.push(Boolean(context.webRetrieval));
        return { callId: '', ok: true, output: context.webRetrieval ? 'present' : 'absent' };
      },
    };
    const llm = scriptedWebLlm();
    const llmChat = vi.mocked(llm.chat);
    const runner = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      approve: async () => true,
      bootstrapDir: dataDir,
      skillsDirs: [],
    });
    runners.push(runner);
    // Even a host-side registry mutation cannot override the frozen disabled/
    // unconfigured provider snapshot for this runner configuration.
    runner.infra.webProviders = new SearchProviderRegistry([provider]);

    const result = await runner.run({ text: `probe ${_label}`, additionalTools: [probe, reservedWebTool] });

    expect(result.status).toBe('ok');
    expect(seen).toEqual([false]);
    expect(providerSearch).not.toHaveBeenCalled();
    expect(reservedWebExecute).not.toHaveBeenCalled();
    expect(llmChat).toHaveBeenCalled();
    expect(llmChat.mock.calls.every(([request]) => (
      !request.tools?.some((tool) => tool.function.name === 'web_search' || tool.function.name === 'web_fetch')
    ))).toBe(true);
    expect(result.webEvidence).toBeUndefined();
  });
});
