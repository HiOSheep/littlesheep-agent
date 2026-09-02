import { describe, expect, it } from 'vitest';
import { formatWebEvidenceSources, type WebEvidenceProjection } from './web-retrieval.js';

describe('plain-text Web evidence projection', () => {
  it('preserves source and partial state without exposing unavailable URL details', () => {
    const evidence: WebEvidenceProjection = {
      version: 1, generatedAt: '2026-08-29T00:00:00.000Z', completeness: 'partial',
      citationIds: ['web-run-source'], citationCount: 1, documentCount: 1, cached: true,
      partial: true, truncated: true, blocked: false, stale: false,
      citations: [{
        id: 'web-run-source', origin: 'https://example.com', urlHash: 'a'.repeat(64),
        title: 'Sensitive URL source', fetchedAt: '2026-08-29T00:00:00.000Z', status: 'partial', truncated: true,
      }],
    };

    const output = formatWebEvidenceSources(evidence);
    expect(output).toContain('cached, partial, truncated');
    expect(output).toContain('https://example.com');
    expect(output).toContain('fetchedAt: 2026-08-29T00:00:00.000Z');
    expect(output).toContain('[citation:web-run-source]');
    expect(output).not.toContain('token=');
  });

  it('keeps zero-source failure states visible without exposing internal error kinds', () => {
    const states: WebEvidenceProjection[] = [
      {
        version: 1, generatedAt: '2026-08-29T00:00:00.000Z', completeness: 'none',
        citationIds: [], citationCount: 0, documentCount: 0, cached: false,
        partial: true, truncated: false, blocked: false, stale: false,
        errorKinds: ['web_disabled'],
      },
      {
        version: 1, generatedAt: '2026-08-29T00:00:00.000Z', completeness: 'none',
        citationIds: [], citationCount: 0, documentCount: 0, cached: false,
        partial: true, truncated: false, blocked: false, stale: false,
        errorKinds: ['web_provider_unconfigured'],
      },
      {
        version: 1, generatedAt: '2026-08-29T00:00:00.000Z', completeness: 'none',
        citationIds: [], citationCount: 0, documentCount: 0, cached: false,
        partial: true, truncated: false, blocked: false, stale: false,
        errorKinds: ['web_provider_rate_limited'],
      },
    ];

    const output = states.map(formatWebEvidenceSources).join('\n');
    expect(output).toContain('No verified sources were returned.');
    expect(output).toContain('Web retrieval is disabled.');
    expect(output).toContain('No web search provider is configured.');
    expect(output).toContain('Web search provider rate limit reached.');
    expect(output).not.toContain('web_disabled');
    expect(output).not.toContain('web_provider_unconfigured');
    expect(output).not.toContain('web_provider_rate_limited');
  });
});
