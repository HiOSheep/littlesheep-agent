// CACHE-09 path comparison: one deterministic, redacted comparison of the same
// fixture run under two Harness paths. It never invents token, latency or
// quality numbers: any incomplete input stays `undefined` and is listed in
// `incomplete`, so a cutover cost/quality claim can never be built on partial
// evidence.

import type { CacheQualityReport } from './cache-quality-report.js';

export type HarnessPathLabel = 'shadow' | 'next' | 'legacy' | 'cutover';

export interface HarnessPathSummary {
  readonly label: HarnessPathLabel;
  readonly requestCount: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly reasoningTokens?: number;
  readonly cachedPromptTokens?: number;
  readonly cacheHitRatio?: number;
  readonly latencyP50Ms?: number;
  readonly latencyP95Ms?: number;
  readonly latencyMaxMs?: number;
  readonly receivedRate?: number;
  readonly failureRate?: number;
  readonly verificationPassRate?: number;
  readonly releaseGateStatus: CacheQualityReport['releaseGate']['status'];
}

export interface HarnessPathComparison {
  readonly version: 1;
  readonly paths: ReadonlyArray<{ label: HarnessPathLabel; summary: HarnessPathSummary }>;
  /** Metric keys absent from at least one path; never guessed or back-filled. */
  readonly incomplete: readonly string[];
  readonly deltas: {
    readonly requestCount?: number;
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly cachedPromptTokens?: number;
    readonly cacheHitRatio?: number;
    readonly latencyP95Ms?: number;
    readonly verificationPassRate?: number;
  };
}

export function compareHarnessPaths(
  inputs: ReadonlyArray<{ label: HarnessPathLabel; report: CacheQualityReport }>,
): HarnessPathComparison {
  if (inputs.length < 2) {
    throw new Error('harness path comparison requires at least two paths');
  }
  const summaries = inputs.map((input) => ({ label: input.label, summary: summarizePath(input.label, input.report) }));
  const metricKeys = [
    'promptTokens',
    'completionTokens',
    'reasoningTokens',
    'cachedPromptTokens',
    'cacheHitRatio',
    'latencyP95Ms',
    'receivedRate',
    'failureRate',
    'verificationPassRate',
  ] as const;
  const incomplete = metricKeys.filter((key) => summaries.some((entry) => entry.summary[key] === undefined));
  const [base, head] = summaries;
  const delta = (key: keyof HarnessPathSummary): number | undefined => {
    const left = base?.summary[key];
    const right = head?.summary[key];
    return typeof left === 'number' && typeof right === 'number' ? right - left : undefined;
  };
  return Object.freeze({
    version: 1 as const,
    paths: Object.freeze(summaries),
    incomplete: Object.freeze(incomplete),
    deltas: Object.freeze({
      ...(delta('requestCount') === undefined ? {} : { requestCount: delta('requestCount')! }),
      ...(delta('promptTokens') === undefined ? {} : { promptTokens: delta('promptTokens')! }),
      ...(delta('completionTokens') === undefined ? {} : { completionTokens: delta('completionTokens')! }),
      ...(delta('cachedPromptTokens') === undefined ? {} : { cachedPromptTokens: delta('cachedPromptTokens')! }),
      ...(delta('cacheHitRatio') === undefined ? {} : { cacheHitRatio: delta('cacheHitRatio')! }),
      ...(delta('latencyP95Ms') === undefined ? {} : { latencyP95Ms: delta('latencyP95Ms')! }),
      ...(delta('verificationPassRate') === undefined ? {} : { verificationPassRate: delta('verificationPassRate')! }),
    }),
  });
}

function summarizePath(label: HarnessPathLabel, report: CacheQualityReport): HarnessPathSummary {
  const providerTokens = report.providerTokens;
  const latency = report.latency;
  return Object.freeze({
    label,
    requestCount: report.requestCount,
    ...(providerTokens.promptTokens === undefined ? {} : { promptTokens: providerTokens.promptTokens }),
    ...(providerTokens.completionTokens === undefined ? {} : { completionTokens: providerTokens.completionTokens }),
    ...(providerTokens.reasoningTokens === undefined ? {} : { reasoningTokens: providerTokens.reasoningTokens }),
    ...(providerTokens.cachedPromptTokens === undefined ? {} : { cachedPromptTokens: providerTokens.cachedPromptTokens }),
    ...(report.providerPrompt.hitRatio === undefined ? {} : { cacheHitRatio: report.providerPrompt.hitRatio }),
    ...(latency?.p50Ms === undefined ? {} : { latencyP50Ms: latency.p50Ms }),
    ...(latency?.p95Ms === undefined ? {} : { latencyP95Ms: latency.p95Ms }),
    ...(latency?.maxMs === undefined ? {} : { latencyMaxMs: latency.maxMs }),
    ...(report.outcomes.receivedRate === undefined ? {} : { receivedRate: report.outcomes.receivedRate }),
    ...(report.outcomes.failureRate === undefined ? {} : { failureRate: report.outcomes.failureRate }),
    ...(report.verification.passRate === undefined ? {} : { verificationPassRate: report.verification.passRate }),
    releaseGateStatus: report.releaseGate.status,
  });
}
