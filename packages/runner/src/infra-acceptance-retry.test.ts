// The acceptance retry override exists so a real-window fixture can inject Provider failures
// and still finish in seconds. Its gate is a real boundary: outside the acceptance build it
// must return nothing at all, and the value it does return must stay bounded — it is read
// from an environment variable, which is not a trusted input.
import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY, DEFAULT_MAX_RETRIES } from '@littlesheep/llm';
import { acceptanceRetryOptions } from './infra.js';

const ACCEPTANCE_ENV = 'LITTLESHEEP_ELECTRON_ACCEPTANCE';
const BASE_DELAY_ENV = 'LITTLESHEEP_ACCEPTANCE_RETRY_BASE_DELAY_MS';

describe('acceptance retry override', () => {
  it('does nothing outside the acceptance build', () => {
    expect(acceptanceRetryOptions({})).toBeUndefined();
    expect(acceptanceRetryOptions({ [BASE_DELAY_ENV]: '60' })).toBeUndefined();
    expect(acceptanceRetryOptions({ [ACCEPTANCE_ENV]: '0', [BASE_DELAY_ENV]: '60' })).toBeUndefined();
  });

  it('does nothing inside the acceptance build without a usable delay', () => {
    expect(acceptanceRetryOptions({ [ACCEPTANCE_ENV]: '1' })).toBeUndefined();
    expect(acceptanceRetryOptions({ [ACCEPTANCE_ENV]: '1', [BASE_DELAY_ENV]: 'nope' })).toBeUndefined();
    expect(acceptanceRetryOptions({ [ACCEPTANCE_ENV]: '1', [BASE_DELAY_ENV]: '0' })).toBeUndefined();
    expect(acceptanceRetryOptions({ [ACCEPTANCE_ENV]: '1', [BASE_DELAY_ENV]: '-50' })).toBeUndefined();
  });

  it('shortens only the wait, and keeps the product retry budget', () => {
    const options = acceptanceRetryOptions({ [ACCEPTANCE_ENV]: '1', [BASE_DELAY_ENV]: '60' });

    expect(options?.retry.baseDelayMs).toBe(60);
    expect(options?.retry.jitter).toBe(false);
    expect(options?.retry.maxAttempts).toBe(DEFAULT_RETRY.maxAttempts);
    expect(options?.retry.maxAttempts).toBe(DEFAULT_MAX_RETRIES + 1);
    expect(options?.retry.retryableStatuses).toEqual(DEFAULT_RETRY.retryableStatuses);
  });

  it('bounds a hostile or mistyped delay', () => {
    expect(acceptanceRetryOptions({ [ACCEPTANCE_ENV]: '1', [BASE_DELAY_ENV]: '100000' })?.retry.baseDelayMs).toBe(250);
    expect(acceptanceRetryOptions({ [ACCEPTANCE_ENV]: '1', [BASE_DELAY_ENV]: '1' })?.retry.baseDelayMs).toBe(1);
  });
});
