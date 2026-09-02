import { describe, expect, it } from 'vitest';
import type { WebEvidenceProjection } from '@littlesheep/types';
import { validateWebCitations, webCitationRepairContract } from './web-citation-validation.js';

const evidence: WebEvidenceProjection = {
  version: 1,
  providerId: 'fixture',
  generatedAt: '2026-08-29T00:00:00.000Z',
  completeness: 'partial',
  citationIds: ['web-run-1-source'],
  citationCount: 1,
  documentCount: 1,
  cached: false,
  partial: true,
  truncated: true,
  blocked: false,
  stale: false,
};

describe('web citation validation', () => {
  it('accepts only exact runtime-issued citation tokens', () => {
    expect(validateWebCitations('Result [citation:web-run-1-source].', evidence)).toMatchObject({ ok: true });
    expect(validateWebCitations('Result without a source.', evidence)).toMatchObject({ ok: false, unknownIds: [] });
    expect(validateWebCitations('Result [citation:web-forged-1-source].', evidence)).toMatchObject({
      ok: false, unknownIds: ['web-forged-1-source'],
    });
  });

  it('does not allow a citation when no web evidence exists', () => {
    expect(validateWebCitations('Claim [citation:web-forged-1-source].', undefined)).toMatchObject({ ok: false });
  });

  it('renders allowed ids and incomplete retrieval state for bounded repair', () => {
    const contract = webCitationRepairContract(evidence);
    expect(contract).toContain('web-run-1-source');
    expect(contract).toContain('partial, truncated');
  });
});
