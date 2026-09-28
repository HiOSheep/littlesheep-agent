// Pure timezone bucketing and daily-series assembly for Provider usage (O5).
//
// Raw attempt times are UTC instants; the calendar day is derived here, at read
// time, from an explicit timezone. Nothing in this module reads or writes disk,
// so a timezone change re-projects the same persisted facts without touching the
// event log.
import type {
  ProviderUsageDailyBackfillProgress,
  ProviderUsageDailyCoverage,
  ProviderUsageDailyDay,
  ProviderUsageDailyDayState,
  ProviderUsageDailyIdentity,
  ProviderUsageDailySeries,
} from '@littlesheep/types';
import {
  PROVIDER_USAGE_DAILY_MAX_IDENTITIES,
  PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS,
  PROVIDER_USAGE_DAILY_VERSION,
} from '@littlesheep/types';
import { localDateRange, localToday, zonedDateKey } from './provider-usage-daily-time.js';

export interface ProviderUsageDailyCountedAttempt {
  /** Provider request id: the dedup identity of one billable attempt. */
  readonly requestId: string;
  readonly at: string;
  readonly provider: string;
  readonly model: string;
  readonly total: number;
  readonly input: number;
  readonly output: number;
  readonly cached: number;
  readonly reasoning: number;
}

export interface ProviderUsageDailyMissingFact {
  readonly requestId: string;
  readonly at: string;
  readonly kind: 'response_without_usage' | 'request_without_response';
  readonly provider: string;
  readonly model: string;
}

/** Projection-wide coverage counters; not scoped to the query range or filters. */
export interface ProviderUsageDailyCoverageInput {
  readonly indexedRuns: number;
  readonly indexedSessions: number;
  readonly attempts: number;
  readonly missingResponses: number;
  readonly unreportedRequests: number;
  readonly unreadableRuns: number;
  readonly modes: { readonly next: number; readonly shadow: number; readonly unknown: number };
  readonly duplicateAttempts: number;
  readonly firstAttemptAt?: string;
  readonly lastAttemptAt?: string;
  readonly updatedAt?: string;
  readonly projectionBuilt: boolean;
  readonly stale: boolean;
  readonly clearedThrough?: string;
  readonly retainedAfterDeleteSessions: number;
  readonly backfill: ProviderUsageDailyBackfillProgress;
}

export interface ProviderUsageDailySeriesInput {
  readonly timezone: string;
  readonly timezoneSource: 'request' | 'system';
  readonly from: string;
  readonly to: string;
  readonly filters: { readonly provider?: string; readonly model?: string };
  readonly attempts: readonly ProviderUsageDailyCountedAttempt[];
  readonly missing: readonly ProviderUsageDailyMissingFact[];
  readonly coverage: ProviderUsageDailyCoverageInput;
  readonly now: Date;
}

export function buildProviderUsageDailySeries(
  input: ProviderUsageDailySeriesInput,
): ProviderUsageDailySeries {
  const dates = localDateRange(input.from, input.to);
  const today = localToday(input.timezone, input.now);
  const providers = new Map<string, ProviderUsageDailyIdentity>();
  const models = new Map<string, ProviderUsageDailyIdentity>();
  const attemptsByDate = new Map<string, ProviderUsageDailyCountedAttempt[]>();
  const missingByDate = new Map<string, ProviderUsageDailyMissingFact[]>();

  for (const attempt of input.attempts) {
    const date = zonedDateKey(attempt.at, input.timezone);
    if (date < input.from || date > input.to) continue;
    const bucket = attemptsByDate.get(date);
    if (bucket) bucket.push(attempt);
    else attemptsByDate.set(date, [attempt]);
    accumulateIdentity(providers, attempt.provider, attempt.total);
    accumulateIdentity(models, attempt.model, attempt.total);
  }
  for (const mark of input.missing) {
    const date = zonedDateKey(mark.at, input.timezone);
    if (date < input.from || date > input.to) continue;
    const bucket = missingByDate.get(date);
    if (bucket) bucket.push(mark);
    else missingByDate.set(date, [mark]);
  }

  const days: ProviderUsageDailyDay[] = [];
  const totals = { total: 0, input: 0, output: 0, cached: 0, reasoning: 0, requests: 0, activeDays: 0 };
  let peak: { date: string; total: number } | undefined;
  for (const date of dates) {
    if (date > today) {
      days.push(emptyDay(date, 'future'));
      continue;
    }
    const attempts = attemptsByDate.get(date) ?? [];
    const marks = missingByDate.get(date) ?? [];
    const missingResponses = marks.filter((mark) => mark.kind === 'response_without_usage').length;
    const unreportedRequests = marks.length - missingResponses;
    const state: ProviderUsageDailyDayState = attempts.length === 0
      ? (marks.length === 0 ? 'empty' : 'partial')
      : (marks.length === 0 ? 'recorded' : 'partial');
    const day: ProviderUsageDailyDay = {
      date,
      state,
      requests: attempts.length,
      total: sum(attempts, (attempt) => attempt.total),
      input: sum(attempts, (attempt) => attempt.input),
      output: sum(attempts, (attempt) => attempt.output),
      cached: sum(attempts, (attempt) => attempt.cached),
      reasoning: sum(attempts, (attempt) => attempt.reasoning),
      missingResponses,
      unreportedRequests,
    };
    days.push(day);
    totals.total += day.total;
    totals.input += day.input;
    totals.output += day.output;
    totals.cached += day.cached;
    totals.reasoning += day.reasoning;
    totals.requests += day.requests;
    if (day.requests > 0) totals.activeDays += 1;
    if (!peak || day.total > peak.total) peak = { date, total: day.total };
  }

  const boundedProviders = boundedIdentities(providers);
  const boundedModels = boundedIdentities(models);
  const coverage: ProviderUsageDailyCoverage = {
    timezone: input.timezone,
    timezoneSource: input.timezoneSource,
    ...input.coverage,
    statement: '',
  };
  const series: ProviderUsageDailySeries = {
    version: PROVIDER_USAGE_DAILY_VERSION,
    timezone: input.timezone,
    range: { from: input.from, to: input.to, days: dates.length },
    bounds: {
      maxRangeDays: PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS,
      maxIdentities: PROVIDER_USAGE_DAILY_MAX_IDENTITIES,
      identitiesTruncated: boundedProviders.truncated || boundedModels.truncated,
    },
    filters: input.filters,
    days,
    totals: { ...totals, ...(peak ? { peak } : {}) },
    identities: { providers: boundedProviders.items, models: boundedModels.items },
    coverage: {
      ...coverage,
      statement: coverageStatement(coverage, input.filters, totals.activeDays),
    },
  };
  return series;
}

function coverageStatement(
  coverage: ProviderUsageDailyCoverage,
  filters: { readonly provider?: string; readonly model?: string },
  activeDays: number,
): string {
  const parts = [
    `统计时区 ${coverage.timezone}（${coverage.timezoneSource === 'request' ? '请求指定' : '默认系统时区'}）`,
    '按 Provider 实报 usage 的 model_response_received 事件时间归入本地日',
    '总量取实报 totalTokens，缺失时按实报输入＋输出求和；缓存读写与推理是子集，不重复计入总量',
    '本地上下文计数、安全估算与 embedding 不计入',
    `同一 requestId 只计一次（已合并 ${coverage.duplicateAttempts} 条重复事件）`,
    `投影覆盖 ${coverage.indexedRuns} 个 run / ${coverage.indexedSessions} 个会话（next ${coverage.modes.next}、shadow ${coverage.modes.shadow}、未知 ${coverage.modes.unknown}）`,
    `缺失覆盖：${coverage.missingResponses} 个响应未报 usage、${coverage.unreportedRequests} 个请求无响应、${coverage.unreadableRuns} 个 run 无法重放`,
    `本区间 ${activeDays} 天有实报调用，其余日期没有记录（不是 0）`,
    `回填状态 ${coverage.backfill.status}（已索引 ${coverage.backfill.indexed}/${coverage.backfill.partitions} 个分区）`,
  ];
  if (filters.provider) parts.push(`已按供应商 ${filters.provider} 过滤`);
  if (filters.model) parts.push(`已按模型 ${filters.model} 过滤`);
  if (coverage.clearedThrough) parts.push(`用户已清空至 ${coverage.clearedThrough}，更早的消耗不再计入也不会被回填还原`);
  if (coverage.retainedAfterDeleteSessions > 0) {
    parts.push(`${coverage.retainedAfterDeleteSessions} 个已永久删除的会话仍保留不含内容的用量摘要`);
  }
  if (!coverage.projectionBuilt) parts.push('尚未建立用量投影，请先刷新或回填');
  if (coverage.stale) parts.push('最近一次更新失败，显示的是上一次成功保存的投影');
  return parts.join('；');
}

function emptyDay(date: string, state: ProviderUsageDailyDayState): ProviderUsageDailyDay {
  return {
    date,
    state,
    requests: 0,
    total: 0,
    input: 0,
    output: 0,
    cached: 0,
    reasoning: 0,
    missingResponses: 0,
    unreportedRequests: 0,
  };
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += pick(item);
  return total;
}

function accumulateIdentity(
  into: Map<string, ProviderUsageDailyIdentity>,
  id: string,
  total: number,
): void {
  const current = into.get(id);
  if (current) into.set(id, { id, requests: current.requests + 1, total: current.total + total });
  else into.set(id, { id, requests: 1, total });
}

function boundedIdentities(
  source: Map<string, ProviderUsageDailyIdentity>,
): { items: ProviderUsageDailyIdentity[]; truncated: boolean } {
  const sorted = [...source.values()].sort((left, right) => (
    right.total - left.total || left.id.localeCompare(right.id)
  ));
  return {
    items: sorted.slice(0, PROVIDER_USAGE_DAILY_MAX_IDENTITIES),
    truncated: sorted.length > PROVIDER_USAGE_DAILY_MAX_IDENTITIES,
  };
}
