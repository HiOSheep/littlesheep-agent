import { describe, expect, it, vi } from 'vitest';
import type {
  FetchedDocument,
  NetworkReadPolicy,
  SearchResponse,
  ToolContext,
  WebEvidenceProjection,
  WebRetrievalRuntimePort,
} from '@littlesheep/types';
import { asSessionId } from '@littlesheep/types';
import { webFetchTool } from './web_fetch.js';
import { webSearchTool } from './web_search.js';
import { durableToolResult } from '../tool-execution-result.js';

const URL = 'https://example.com/current?page=1';

function policy(overrides: Partial<NetworkReadPolicy> = {}): NetworkReadPolicy {
  return {
    version: 1, enabled: true, providerId: 'fake', mode: 'public_anonymous',
    allowDomains: [], blockDomains: [], strictReadApproval: false,
    maxResults: 10, maxQueryChars: 2_000, maxQueriesPerRun: 4, maxFetchesPerRun: 4,
    maxConcurrentRequests: 4, searchTimeoutMs: 1_000, fetchTimeoutMs: 1_000,
    totalTimeoutMs: 5_000, maxResponseBytes: 64 * 1024, maxExtractedChars: 40_000,
    maxRedirects: 5, cacheEnabled: true, cacheTtlSeconds: 300, cacheMaxBytes: 1024 * 1024,
    browserFallback: 'approval_required', sensitiveQueryPolicy: 'approve',
    ...overrides,
  };
}

function evidence(overrides: Partial<WebEvidenceProjection> = {}): WebEvidenceProjection {
  return {
    version: 1, providerId: 'fake', generatedAt: '2026-08-29T00:00:00.000Z',
    completeness: 'complete', citationIds: ['web-run-1-hash'], citationCount: 1,
    documentCount: 0, cached: false, partial: false, truncated: false,
    blocked: false, stale: false, ...overrides,
  };
}

function searchResponse(): SearchResponse {
  return {
    version: 1, provider: 'fake', query: 'current docs', fetchedAt: '2026-08-29T00:00:00.000Z',
    cached: false, partial: false, warnings: [],
    results: [{
      rank: 1, title: 'Current docs', url: URL, canonicalUrl: URL,
      snippet: 'Current public result.', citationId: 'web-run-1-hash', sourceStatus: 'search_result',
    }],
  };
}

function document(content = 'Current public page body.'): FetchedDocument {
  return {
    version: 1, requestedUrl: URL, finalUrl: URL, redirectChain: [], status: 200,
    contentType: 'text/html', title: 'Current docs', extractor: 'readability', content,
    contentHash: 'sha256:document', fetchedAt: '2026-08-29T00:00:00.000Z',
    cached: false, truncated: false, externalUntrusted: true, warnings: [],
    citationId: 'web-run-1-hash',
  };
}

function runtime(overrides: Partial<WebRetrievalRuntimePort> = {}): WebRetrievalRuntimePort {
  return {
    search: vi.fn(async () => searchResponse()),
    fetch: vi.fn(async () => document()),
    evidence: vi.fn(() => evidence()),
    ...overrides,
  };
}

function context(webRetrieval?: WebRetrievalRuntimePort, networkPolicy = policy()): ToolContext {
  return {
    runId: 'run-1', sessionId: asSessionId('session-1'), cwd: process.cwd(),
    permissionMode: 'research', networkPolicy, webRetrieval,
    webEvidenceSink: { record: vi.fn() },
  };
}

describe('web_search built-in', () => {
  it('uses a strict bounded schema that cannot express arbitrary HTTP options', () => {
    expect(() => webSearchTool.inputSchema.parse({ query: 'docs', endpoint: 'https://evil.example' })).toThrow();
    expect(() => webSearchTool.inputSchema.parse({ query: 'docs', headers: { authorization: 'secret' } })).toThrow();
    expect(() => webSearchTool.inputSchema.parse({ query: 'bad\nquery' })).toThrow();
    expect(() => webSearchTool.inputSchema.parse({ query: 'docs', maxResults: Number.NaN })).toThrow();
    expect(() => webSearchTool.inputSchema.parse({ query: 'docs', maxResults: 21 })).toThrow();
  });

  it('returns rich model evidence but a content-free durable output and projection', async () => {
    const port = runtime();
    const ctx = context(port);
    const result = await webSearchTool.execute({ query: ' current docs ', maxResults: 2 }, ctx);

    expect(result.ok).toBe(true);
    expect(port.search).toHaveBeenCalledWith(expect.objectContaining({
      query: 'current docs', maxResults: 2, runId: 'run-1',
    }), undefined);
    expect(JSON.stringify(result.modelOutput)).toContain('Current public result.');
    expect(String(result.output)).not.toContain('Current public result.');
    expect(String(result.output)).not.toContain('current docs');
    expect(result.webEvidence).toEqual(evidence());
    expect(ctx.webEvidenceSink?.record).toHaveBeenCalledWith(evidence());
  });

  it('fails closed without runtime and sends zero provider requests', async () => {
    const result = await webSearchTool.execute({ query: 'docs' }, context(undefined));
    expect(result).toMatchObject({ ok: false, meta: { errorKind: 'web_provider_unconfigured' } });
  });

  it.each(['deny', 'approve'] as const)('does not send a sensitive query under %s without explicit approval', async (sensitiveQueryPolicy) => {
    const port = runtime();
    const result = await webSearchTool.execute(
      { query: 'find api_key=fixture-secret docs' },
      context(port, policy({ sensitiveQueryPolicy })),
    );
    expect(result).toMatchObject({ ok: false, meta: { errorKind: 'web_sensitive_query_blocked' } });
    expect(port.search).not.toHaveBeenCalled();
  });

  it('blocks controlled credential, private-file and Memory fixtures before provider egress', async () => {
    const port = runtime();
    const fixtures = [
      'public docs for api_key=RCD_FAKE_SECRET_42',
      'summarize private file C:\\Users\\Fixture\\notes.txt containing RCD_PRIVATE_FILE_CANARY',
      'search private memory containing RCD_PRIVATE_MEMORY_CANARY',
    ];
    for (const query of fixtures) {
      const result = await webSearchTool.execute(
        { query },
        context(port, policy({ sensitiveQueryPolicy: 'deny' })),
      );
      expect(result).toMatchObject({ ok: false, meta: { errorKind: 'web_sensitive_query_blocked' } });
    }
    expect(port.search).not.toHaveBeenCalled();
  });

  it('does not treat private prose as safely redactable', async () => {
    const port = runtime();
    const result = await webSearchTool.execute(
      { query: 'find public guidance using private Memory content RCD_PRIVATE_MEMORY_CANARY' },
      context(port, policy({ sensitiveQueryPolicy: 'redact' })),
    );
    expect(result).toMatchObject({ ok: false, meta: { errorKind: 'web_sensitive_query_blocked' } });
    expect(port.search).not.toHaveBeenCalled();
  });

  it('requires and honors an explicit approval for configured Web reads', async () => {
    const port = runtime();
    const approve = vi.fn(async () => false);
    const denied = await webSearchTool.execute(
      { query: 'public API documentation' },
      { ...context(port, policy({ strictReadApproval: true })), approve },
    );
    expect(denied).toMatchObject({ ok: false, meta: { errorKind: 'web_sensitive_query_blocked' } });
    expect(port.search).not.toHaveBeenCalled();

    approve.mockResolvedValueOnce(true);
    const allowed = await webSearchTool.execute(
      { query: 'public API documentation' },
      { ...context(port, policy({ strictReadApproval: true })), approve },
    );
    expect(allowed.ok).toBe(true);
    expect(port.search).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledTimes(2);
  });

  it('returns a bounded failure for network errors without fabricating evidence', async () => {
    const port = runtime({
      search: vi.fn(async () => { throw Object.assign(new Error('fixture timeout'), { kind: 'web_fetch_timeout' }); }),
      evidence: vi.fn(() => evidence({ completeness: 'none', citationIds: [], citationCount: 0, partial: true, errorKinds: ['web_fetch_timeout'] })),
    });
    const result = await webSearchTool.execute({ query: 'public API documentation' }, context(port));
    expect(result).toMatchObject({ ok: false, meta: { errorKind: 'web_fetch_timeout' } });
    expect(result.webEvidence).toMatchObject({ completeness: 'none', citationCount: 0 });
  });

  it('passes the Runtime cancellation signal to the request and does not retry', async () => {
    const controller = new AbortController();
    controller.abort();
    const port = runtime({ search: vi.fn(async (_request, signal) => {
      expect(signal).toBe(controller.signal);
      throw Object.assign(new Error('cancelled fixture'), { kind: 'web_fetch_cancelled' });
    }) });
    const result = await webSearchTool.execute(
      { query: 'public API documentation' },
      { ...context(port), signal: controller.signal },
    );
    expect(result).toMatchObject({ ok: false, meta: { errorKind: 'web_fetch_cancelled' } });
    expect(port.search).toHaveBeenCalledTimes(1);
  });

  it('redacts sensitive values before provider egress', async () => {
    const port = runtime();
    const ctx = context(port, policy({ sensitiveQueryPolicy: 'redact' }));
    const result = await webSearchTool.execute({ query: 'find api_key=fixture-secret docs' }, ctx);
    expect(result.ok).toBe(true);
    expect(port.search).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.not.stringContaining('fixture-secret'),
    }), undefined);
  });

  it('allows an explicitly approved sensitive query without exposing it in the approval projection', async () => {
    const port = runtime();
    const approve = vi.fn(async (_action: string, _detail?: unknown) => true);
    const ctx = { ...context(port), approve };
    const result = await webSearchTool.execute({ query: 'find api_key=fixture-secret docs' }, ctx);
    expect(result.ok).toBe(true);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(approve.mock.calls[0]?.[1])).not.toContain('fixture-secret');
    expect(port.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'find api_key=fixture-secret docs' }), undefined);
    const projected = webSearchTool.persistence?.projectInput({ query: 'find api_key=fixture-secret docs' });
    expect(JSON.stringify(projected)).not.toContain('fixture-secret');
    expect(projected).toMatchObject({ sensitiveQuery: true, queryHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });
});

describe('durable Web result boundary', () => {
  it('drops model bodies and non-whitelisted evidence fields', () => {
    const durable = durableToolResult({
      callId: 'web-call', ok: true, output: 'safe', modelOutput: { content: 'MODEL_BODY' },
      webEvidence: {
        ...evidence(),
        query: 'PRIVATE_QUERY',
        documents: [{ content: 'EVIDENCE_BODY' }],
      } as never,
    });
    const serialized = JSON.stringify(durable);
    expect(serialized).not.toContain('MODEL_BODY');
    expect(serialized).not.toContain('PRIVATE_QUERY');
    expect(serialized).not.toContain('EVIDENCE_BODY');
    expect(durable.webEvidence?.citationIds).toEqual(evidence().citationIds);
  });
});

describe('web_fetch built-in', () => {
  it('uses a strict schema without method, headers, body, credentials, proxy or output path', () => {
    for (const extra of ['method', 'headers', 'body', 'credentials', 'proxy', 'outputPath']) {
      expect(() => webFetchTool.inputSchema.parse({ url: URL, [extra]: 'forbidden' })).toThrow();
    }
    expect(() => webFetchTool.inputSchema.parse({ url: 'https://example.com/a path' })).toThrow();
    expect(() => webFetchTool.inputSchema.parse({ url: URL, maxChars: Number.POSITIVE_INFINITY })).toThrow();
  });

  it('returns bounded model-only body while durable output remains content-free', async () => {
    const body = 'x'.repeat(8_000);
    const port = runtime({ fetch: vi.fn(async () => document(body)) });
    const ctx = context(port);
    const result = await webFetchTool.execute({ url: URL, citationId: 'web-run-1-hash' }, ctx);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.modelOutput)).toContain('x'.repeat(100));
    expect(JSON.stringify(result.modelOutput)).not.toContain('x'.repeat(7_001));
    expect(String(result.output)).not.toContain('x'.repeat(100));
    expect(result.webEvidence).toMatchObject({ partial: true, truncated: true, completeness: 'partial' });
    expect(port.fetch).toHaveBeenCalledWith({ url: URL, citationId: 'web-run-1-hash' }, undefined);
  });

  it('projects only URL origin/hash and never path or query secrets', () => {
    const projected = webFetchTool.persistence?.projectInput({
      url: 'https://example.com/private/path?token=fixture-secret', maxChars: 100,
    });
    expect(projected).toMatchObject({ url: 'https://example.com/', urlHash: expect.stringMatching(/^[a-f0-9]{64}$/u), maxChars: 100 });
    expect(JSON.stringify(projected)).not.toContain('private/path');
    expect(JSON.stringify(projected)).not.toContain('fixture-secret');
  });

  it('maps runtime errors to stable bounded kinds without leaking messages', async () => {
    const port = runtime({
      fetch: vi.fn(async () => { throw Object.assign(new Error('secret transport detail'), { kind: 'web_ssrf_blocked' }); }),
      evidence: vi.fn(() => evidence({ completeness: 'none', citationIds: [], citationCount: 0, blocked: true, partial: true, errorKinds: ['web_ssrf_blocked'] })),
    });
    const result = await webFetchTool.execute({ url: URL }, context(port));
    expect(result).toMatchObject({ ok: false, meta: { errorKind: 'web_ssrf_blocked' } });
    expect(String(result.error)).not.toContain('secret transport detail');
    expect(result.webEvidence).toMatchObject({ blocked: true });
  });
});
