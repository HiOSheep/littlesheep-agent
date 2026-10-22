import { describe, expect, it } from 'vitest';
import { runOfflinePreflight } from './preflight.mjs';

describe('R4-D0 offline provider preflight', () => {
  it('passes without network access and never arms the live gate', () => {
    const preflight = runOfflinePreflight();
    expect(preflight.ok).toBe(true);
    expect(preflight.networkUsed).toBe(false);
    expect(preflight.liveAuthorizationArmed).toBe(false);
    expect(preflight.authorizationPending).toBeUndefined();
    expect(preflight.checks.length).toBeGreaterThanOrEqual(18);
    expect(preflight.checks.every((item) => item.ok)).toBe(true);
  });

  it('keeps the fake credential and real credential material out of output', () => {
    const preflight = runOfflinePreflight();
    const text = JSON.stringify(preflight);
    expect(text).not.toContain('r4d0-offline-fixture-not-a-real-key');
    expect(text).not.toContain('apiKey');
    expect(preflight.providerProjection.modelMapping.status).toBe('resolved');
    expect(preflight.providerProjection.wireModelId).toBe('deepseek-chat');
  });

  it('freezes cost/usage policy without claiming a verified provider cost cap', () => {
    const preflight = runOfflinePreflight();
    expect(preflight.costCap.providerSideVerified).toBe(false);
    expect(preflight.costCap.required).toBe(true);
    expect(preflight.providerProjection.usageSource).toContain('unavailable');
    expect(preflight.providerProjection.costSource).toContain('billing receipt');
    expect(preflight.providerProjection.nonRetryableStatuses).toEqual([400, 401, 403, 404, 422]);
  });

  it('rejects incomplete budgets before any request', () => {
    const preflight = runOfflinePreflight();
    const missingCost = preflight.checks.find((item) => item.id === 'missing-cost-budget-blocked');
    const billing = preflight.checks.find((item) => item.id === 'unconfirmed-billing-cap-blocked');
    expect(missingCost?.ok).toBe(true);
    expect(billing?.ok).toBe(true);
  });
});
