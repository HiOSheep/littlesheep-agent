import { describe, expect, it } from 'vitest';
import {
  readSessionSummaryFidelityFields,
  SESSION_SUMMARY_FIDELITY_END,
  SESSION_SUMMARY_FIDELITY_START,
  stripSessionSummaryFidelitySections,
} from './session-summary-fidelity-text.js';

describe('session summary fidelity text', () => {
  it('reads only exact field lines from the latest complete Runtime envelope', () => {
    const value = [
      `${SESSION_SUMMARY_FIDELITY_START}\n代号: stale\n${SESSION_SUMMARY_FIDELITY_END}`,
      '模型语义摘要里的代号是 wrong。',
      SESSION_SUMMARY_FIDELITY_START,
      '# Runtime-preserved exact fields',
      'These user-provided label/value pairs are authoritative for exact recall:',
      '代号: stable-42',
      '路径: C:\\workspace\\demo',
      SESSION_SUMMARY_FIDELITY_END,
    ].join('\n');

    expect(readSessionSummaryFidelityFields(value)).toEqual([
      { label: '代号', value: 'stable-42' },
      { label: '路径', value: 'C:\\workspace\\demo' },
    ]);
  });

  it('removes complete and incomplete model-authored envelopes before rebuilding', () => {
    expect(stripSessionSummaryFidelitySections([
      '语义摘要',
      SESSION_SUMMARY_FIDELITY_START,
      '代号: wrong',
      SESSION_SUMMARY_FIDELITY_END,
      '保留结尾',
    ].join('\n'))).toContain('保留结尾');
    expect(stripSessionSummaryFidelitySections([
      '语义摘要',
      SESSION_SUMMARY_FIDELITY_START,
      '代号: incomplete',
    ].join('\n'))).toBe('语义摘要\n');
  });
});
