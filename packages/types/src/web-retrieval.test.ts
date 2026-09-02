import { describe, expect, it } from 'vitest';
import {
  WEB_RETRIEVAL_CONTRACT_VERSION,
  type FetchedDocument,
  type NetworkReadPolicy,
  type SearchResponse,
  type WebEvidenceProjection,
  sanitizeWebEvidenceProjection,
} from './index.js';

describe('web retrieval contracts', () => {
  it('keeps run-local content separate from bounded persistent evidence', () => {
    const document: FetchedDocument = {
      version: WEB_RETRIEVAL_CONTRACT_VERSION,
      requestedUrl: 'https://example.com/article',
      finalUrl: 'https://example.com/article',
      redirectChain: [],
      status: 200,
      contentType: 'text/html',
      extractor: 'readability',
      content: 'external untrusted body',
      contentHash: 'sha256:fixture',
      fetchedAt: '2026-08-29T00:00:00.000Z',
      cached: false,
      truncated: false,
      externalUntrusted: true,
      warnings: [],
    };
    const projection: WebEvidenceProjection = {
      version: WEB_RETRIEVAL_CONTRACT_VERSION,
      providerId: 'fake',
      generatedAt: document.fetchedAt,
      completeness: 'complete',
      citationIds: ['web-1'],
      citations: [{
        id: 'web-1',
        url: 'https://example.com/article',
        origin: 'https://example.com',
        urlHash: 'a'.repeat(64),
        fetchedAt: document.fetchedAt,
        status: 'fetched',
        contentHash: document.contentHash,
        truncated: false,
      }],
      citationCount: 1,
      documentCount: 1,
      cached: false,
      partial: false,
      truncated: false,
      blocked: false,
      stale: false,
    };

    expect(document.externalUntrusted).toBe(true);
    expect(JSON.stringify(projection)).not.toContain(document.content);
    expect('documents' in projection).toBe(false);
  });

  it('represents provider-neutral search and immutable policy shapes', () => {
    const policy: NetworkReadPolicy = {
      version: WEB_RETRIEVAL_CONTRACT_VERSION,
      enabled: true,
      providerId: 'fake',
      mode: 'public_anonymous',
      allowDomains: [],
      blockDomains: [],
      strictReadApproval: false,
      maxQueryChars: 2_000,
      maxResults: 10,
      maxQueriesPerRun: 4,
      maxFetchesPerRun: 4,
      maxConcurrentRequests: 4,
      searchTimeoutMs: 15_000,
      fetchTimeoutMs: 20_000,
      totalTimeoutMs: 90_000,
      maxResponseBytes: 2 * 1024 * 1024,
      maxExtractedChars: 40_000,
      maxRedirects: 5,
      cacheEnabled: true,
      cacheTtlSeconds: 300,
      cacheMaxBytes: 64 * 1024 * 1024,
      browserFallback: 'approval_required',
      sensitiveQueryPolicy: 'approve',
    };
    const response: SearchResponse = {
      version: WEB_RETRIEVAL_CONTRACT_VERSION,
      provider: 'fake',
      query: 'current documentation',
      results: [{
        rank: 1,
        title: 'Official documentation',
        url: 'https://example.com/docs',
        citationId: 'web-1',
        sourceStatus: 'search_result',
      }],
      fetchedAt: '2026-08-29T00:00:00.000Z',
      cached: false,
      partial: false,
      warnings: [],
    };

    expect(policy.providerId).toBe(response.provider);
    expect(response.results[0]?.citationId).toBe('web-1');
  });

  it('whitelists durable projection fields and drops injected content and signed URLs', () => {
    const sanitized = sanitizeWebEvidenceProjection({
      version: 1,
      providerId: 'fake',
      generatedAt: '2026-08-29T00:00:00.000Z',
      completeness: 'complete',
      citationIds: ['web-run-1-source'],
      citations: [{
        id: 'web-run-1-source',
        url: 'https://example.com/private?token=fixture-secret',
        origin: 'https://example.com',
        urlHash: 'a'.repeat(64),
        fetchedAt: '2026-08-29T00:00:00.000Z',
        status: 'fetched',
        truncated: false,
        snippet: 'must disappear',
      }],
      citationCount: 1,
      documentCount: 1,
      cached: false,
      partial: false,
      truncated: false,
      blocked: false,
      stale: false,
      query: 'must disappear',
      documents: [{ content: 'must disappear' }],
    });
    const durable = JSON.stringify(sanitized);
    expect(sanitized?.citations?.[0]?.url).toBeUndefined();
    expect(durable).not.toContain('fixture-secret');
    expect(durable).not.toContain('must disappear');
  });
});
