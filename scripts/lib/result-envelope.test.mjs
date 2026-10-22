import { describe, expect, it } from 'vitest';
import {
  RESULT_ENVELOPE_SCHEMA_VERSION,
  assertResultEnvelope,
  createResultEnvelope,
  isResultEnvelope,
  parseResultEnvelope,
} from './result-envelope.mjs';

describe('script result envelope', () => {
  it('creates one versioned envelope with a consistent exit code', () => {
    expect(createResultEnvelope({ kind: 'rehearsal', status: 'passed', data: { n: 20 } })).toEqual({
      schemaVersion: RESULT_ENVELOPE_SCHEMA_VERSION,
      kind: 'rehearsal',
      status: 'passed',
      exitCode: 0,
      data: { n: 20 },
    });
    expect(createResultEnvelope({ kind: 'rehearsal', status: 'failed' }).exitCode).toBe(1);
    expect(createResultEnvelope({ kind: 'rehearsal', status: 'blocked' }).exitCode).toBe(2);
    expect(createResultEnvelope({ kind: 'rehearsal', status: 'skipped' }).exitCode).toBe(0);
  });

  it('rejects malformed kinds, statuses and exit codes', () => {
    expect(() => createResultEnvelope({ kind: 'Bad Kind', status: 'passed' })).toThrow(/kind/);
    expect(() => createResultEnvelope({ kind: 'x', status: 'ok' })).toThrow(/status/);
    expect(() => createResultEnvelope({ kind: 'x', status: 'passed', exitCode: 300 })).toThrow(/exitCode/);
  });

  it('parses output and enforces the expected kind', () => {
    const envelope = createResultEnvelope({ kind: 'verify-demo', status: 'failed', reason: 'one check failed' });
    expect(parseResultEnvelope(JSON.stringify(envelope), { expectedKind: 'verify-demo' })).toEqual(envelope);
    expect(parseResultEnvelope(`\n${JSON.stringify(envelope)}\n`).kind).toBe('verify-demo');
    expect(() => parseResultEnvelope('{"ok":true}')).toThrow(/schemaVersion/);
    expect(() => parseResultEnvelope(JSON.stringify(envelope), { expectedKind: 'other' })).toThrow(/expected kind/);
    expect(() => parseResultEnvelope('not json')).toThrow(/valid JSON/);
    expect(isResultEnvelope(envelope)).toBe(true);
    expect(assertResultEnvelope(envelope).kind).toBe('verify-demo');
  });
});
