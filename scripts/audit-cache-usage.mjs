#!/usr/bin/env node
/**
 * Cache, usage and cost audit for one or more harness comparison samples.
 *
 * Every number here answers a question the prompt cache work has to be judged
 * by: how much of each request was reused (hit ratio), how much fresh content
 * each task and each call cost (uncached tokens), how many model calls a run
 * needed, how long a run took, and how long the first model request took.
 *
 * Measurement rules this script is held to:
 * - hit ratio is sum(cached_input_tokens) / sum(input_tokens) across every
 *   recorded model request; it is never the average of per-request ratios.
 * - every model purpose counts: reply, decide, execute, verify, recover,
 *   classify, rewrites, retries and compaction calls all stay in the ledger.
 * - unknown usage is counted and named, never filled in with zero. While any
 *   request or run reports incomplete usage the 95% conclusion is reported as
 *   unavailable instead of being computed from partial sums.
 * - run failures and Provider retries are reported separately: they change the
 *   call ledger, they are not cache behaviour.
 * - the first recorded model request is named a model request. A real tool
 *   action is measured from the tool invocation records and stays `unavailable`
 *   when the sample has none.
 *
 * Usage:
 *   node scripts/audit-cache-usage.mjs <dataDir> [<dataDir> ...]
 *   node scripts/audit-cache-usage.mjs --latest              # newest sample under TEMP
 *   node scripts/audit-cache-usage.mjs --json <dataDir> ...  # sanitized summary
 *   node scripts/audit-cache-usage.mjs --sessions <dataDir>  # session-cumulative red line
 *
 * Two criteria are reported, and they are not interchangeable:
 *   - `--sessions` gives the current real-long-task red line (2026-09-22): the
 *     session-cumulative H_ui = ΣcacheRead / Σ(uncachedInput + cacheRead +
 *     cacheWrite), computed exactly like the DeepSeek Harness front end, cold
 *     start included, with detached compaction listed separately and folded into
 *     H_all. This is the metric long tasks are accepted on.
 *   - the default summary keeps the historical 3.1 short-load figures (overall
 *     hit ratio and the steady-state figure that excludes each session's first
 *     request). They remain regression evidence for the frozen short loads and
 *     must not be presented as the long-task red line.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  HIT_TARGET_PERCENT as SESSION_HIT_TARGET_PERCENT,
  judgeNodes,
  projectSessions,
  readLedger,
  summarizeSessions,
} from './lib/session-cache-ledger.mjs';

const USAGE = 'usage: node scripts/audit-cache-usage.mjs [--json] <dataDir>... | --latest';

/** The plan's target, reported but never assumed. */
const HIT_TARGET_PERCENT = 95;

function latestSampleDir() {
  const root = tmpdir();
  const candidates = readdirSync(root)
    .filter((name) => name.startsWith('littlesheep-path-next-'))
    .map((name) => join(root, name))
    .filter((path) => {
      try {
        return statSync(join(path, 'data', 'execution-logs')).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ? join(candidates[0], 'data') : undefined;
}

function percentile(values, p) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function average(values) {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function fmt(value, digits = 0) {
  return value === undefined ? 'n/a' : value.toFixed(digits);
}

function percent(numerator, denominator) {
  return denominator === 0 ? undefined : (numerator / denominator) * 100;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? undefined : numerator / denominator;
}

function readLogs(dataDir) {
  const dir = join(dataDir, 'execution-logs');
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    console.error(`audit-cache-usage: no execution logs under ${dir}`);
    process.exitCode = 1;
    return { logs: [], unparsed: [], files: 0 };
  }
  const logs = [];
  const unparsed = [];
  for (const name of names) {
    try {
      const log = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      log.__file = name;
      logs.push(log);
    } catch {
      // A half written log is not a reason to fail the audit, but it is a
      // reason to say so: silently dropping one shrinks the ledger.
      unparsed.push(name);
    }
  }
  // Chronological order is required for the cold-start split: the cold-start
  // request is the session's FIRST request in time, which filename order does not
  // give. Logs without a parseable startedAt keep their relative position.
  logs.sort((a, b) => {
    const at = typeof a.startedAt === 'string' ? Date.parse(a.startedAt) : Number.NaN;
    const bt = typeof b.startedAt === 'string' ? Date.parse(b.startedAt) : Number.NaN;
    if (Number.isNaN(at) || Number.isNaN(bt)) return 0;
    return at - bt;
  });
  return { logs, unparsed, files: names.length };
}

function emptyPurpose() {
  return {
    calls: 0,
    input: 0,
    cached: 0,
    uncached: 0,
    unknownUncached: 0,
    missingUsage: 0,
    retries: 0,
    systemLengths: new Map(),
  };
}

/** One provider prompt observation, with every unknown kept explicit. */
function promptUsage(request) {
  const prompt = request.cacheObservation?.providerPrompt;
  const input = count(prompt?.tokenCount);
  const cached = count(prompt?.cachedTokenCount);
  const reportedUncached = count(prompt?.uncachedTokenCount);
  let uncached = reportedUncached;
  let derived = false;
  if (uncached === undefined && input !== undefined && cached !== undefined) {
    uncached = Math.max(0, input - cached);
    derived = true;
  }
  return { input, cached, uncached, derived };
}

/**
 * Read request-level cache observations. The plan requires every model use to
 * enter the ledger, including compaction, which runs in its own detached context
 * and is therefore NOT listed in a run's `modelRequests`. Without this the ledger
 * silently undercounts (measured: a compaction load logged 40 requests but made
 * 100, so 60 compaction calls were missing).
 */
function readObservations(dataDir) {
  const dir = join(dataDir, 'cache-observations');
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return { observations: [], files: 0, present: false };
  }
  const observations = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const observation = raw.observation ?? raw;
      const prompt = observation.providerPrompt ?? {};
      observations.push({
        requestKind: typeof observation.requestKind === 'string' ? observation.requestKind : 'unknown',
        modelRequestId: typeof observation.modelRequestId === 'string' ? observation.modelRequestId : undefined,
        input: count(prompt.tokenCount),
        cached: count(prompt.cachedTokenCount),
        uncached: count(prompt.uncachedTokenCount),
      });
    } catch {
      // A half-written observation is itself a ledger gap; counted as unparsable.
    }
  }
  return { observations, files: names.length, present: true };
}

function audit(dataDir) {
  const { logs, unparsed, files } = readLogs(dataDir);
  if (logs.length === 0 && unparsed.length === 0) return undefined;
  const observed = readObservations(dataDir);

  const byPurpose = new Map();
  const byStatus = new Map();
  const retriesByReason = new Map();
  const failures = [];
  const callsPerRun = [];
  const uncachedPerRun = [];
  const durations = [];
  const firstModelRequestDelays = [];
  const firstToolActionDelays = [];
  const rewrites = new Map();
  let inputTokens = 0;
  let cachedTokens = 0;
  let uncachedTokens = 0;
  let outputTokens = 0;
  let outputKnownRuns = 0;
  let requestCount = 0;
  // Steady-state vs cold-start accumulators (acceptance 3.1).
  let steadyRequests = 0;
  let steadyInput = 0;
  let steadyCached = 0;
  let coldStartRequests = 0;
  let coldStartInput = 0;
  let coldStartCached = 0;
  let inputReported = 0;
  let cachedReported = 0;
  let uncachedReported = 0;
  let uncachedDerived = 0;
  let missingUsageRequests = 0;
  let retryRequests = 0;
  let providerAttempts = 0;
  let runsWithIncompleteUsage = 0;
  let runsWithoutRequests = 0;
  let runsWithoutOutputUsage = 0;
  let runUsagePromptTokens = 0;
  let runUsagePromptRuns = 0;
  let failedTraceSteps = 0;
  let runsWithToolActions = 0;

  // A cold start is the FIRST request of a session, not of a run: a session can
  // span many runs (one request each), so classifying per run would mark every
  // request cold. Seen sessions are tracked across the whole sample.
  const seenSessions = new Set();
  const loggedRequestIds = new Set();
  for (const [index, log] of logs.entries()) {
    const label = `run#${index + 1}`;
    const requests = Array.isArray(log.modelRequests) ? log.modelRequests : [];
    callsPerRun.push(requests.length);
    if (requests.length === 0) runsWithoutRequests += 1;

    const status = typeof log.status === 'string' ? log.status : 'unknown';
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    if (status !== 'ok') {
      const error = typeof log.error === 'string' && log.error.trim() ? log.error.trim() : undefined;
      failures.push({ label, status, ...(error ? { error } : {}) });
    }

    const usage = log.usage ?? {};
    if (usage.usageCompleteness !== 'complete') runsWithIncompleteUsage += 1;
    const completion = count(usage.completionTokens);
    if (completion === undefined) runsWithoutOutputUsage += 1;
    else {
      outputTokens += completion;
      outputKnownRuns += 1;
    }
    const usagePrompt = count(usage.promptTokens);
    if (usagePrompt !== undefined) {
      runUsagePromptTokens += usagePrompt;
      runUsagePromptRuns += 1;
    }
    const attempts = count(usage.observedAttemptCount);
    if (attempts !== undefined) providerAttempts += attempts;

    if (typeof log.durationMs === 'number') durations.push(log.durationMs);

    const startedAt = log.startedAt ? Date.parse(log.startedAt) : undefined;
    const firstRequest = requests[0];
    const firstRequestAt = typeof firstRequest?.createdAt === 'string'
      ? Date.parse(firstRequest.createdAt)
      : undefined;
    if (startedAt !== undefined && firstRequestAt !== undefined && firstRequestAt >= startedAt) {
      firstModelRequestDelays.push(firstRequestAt - startedAt);
    }

    const invocations = Array.isArray(log.toolInvocations) ? log.toolInvocations : [];
    if (invocations.length > 0) runsWithToolActions += 1;
    const firstToolAt = invocations
      .map((invocation) => (typeof invocation?.proposedAt === 'string'
        ? Date.parse(invocation.proposedAt)
        : undefined))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    if (startedAt !== undefined && firstToolAt !== undefined && firstToolAt >= startedAt) {
      firstToolActionDelays.push(firstToolAt - startedAt);
    }

    for (const step of log.trace ?? []) {
      if (step?.ok === false) failedTraceSteps += 1;
    }

    const rewriteCount = log.replyProvenance?.rewriteCount;
    if (typeof rewriteCount === 'number') {
      rewrites.set(rewriteCount, (rewrites.get(rewriteCount) ?? 0) + 1);
    }

    let runUncached = 0;
    let runComplete = true;
    let requestCountInRun = 0;
    for (const request of requests) {
      requestCount += 1;
      if (typeof request.id === 'string') loggedRequestIds.add(request.id);
      const purpose = request.callContract?.purpose ?? 'unknown';
      const entry = byPurpose.get(purpose) ?? emptyPurpose();
      entry.calls += 1;
      // The first system message is the stable prompt; a per-request runtime
      // segment is appended as a trailing system message and is reported by the
      // purpose hit ratio instead of by prompt length.
      const system = (request.messages ?? []).find((message) => message.role === 'system');
      const systemLength = typeof system?.characterCount === 'number' ? system.characterCount : -1;
      entry.systemLengths.set(systemLength, (entry.systemLengths.get(systemLength) ?? 0) + 1);

      if (typeof request.retryOf === 'string') {
        entry.retries += 1;
        retryRequests += 1;
        const reason = typeof request.retryReason === 'string' ? request.retryReason : 'unspecified';
        retriesByReason.set(reason, (retriesByReason.get(reason) ?? 0) + 1);
      }

      const observation = promptUsage(request);
      if (observation.input !== undefined) {
        entry.input += observation.input;
        inputTokens += observation.input;
        inputReported += 1;
      }
      if (observation.cached !== undefined) {
        entry.cached += observation.cached;
        cachedTokens += observation.cached;
        cachedReported += 1;
      }
      if (observation.uncached !== undefined) {
        entry.uncached += observation.uncached;
        uncachedTokens += observation.uncached;
        runUncached += observation.uncached;
        uncachedReported += 1;
        if (observation.derived) {
          entry.unknownUncached += 1;
          uncachedDerived += 1;
        }
      } else {
        entry.unknownUncached += 1;
      }
      if (observation.input === undefined || observation.cached === undefined) {
        entry.missingUsage += 1;
        missingUsageRequests += 1;
        runComplete = false;
      }

      // Steady-state vs cold-start split (acceptance 3.1). A cold-start request is
      // the first request of its SESSION, i.e. a category defined by position
      // rather than by cherry-picking favourable samples: every other request,
      // including failures, retries, cancellations and auxiliary calls, is counted
      // in the steady-state figure.
      const sessionKey = typeof log.sessionId === 'string' && log.sessionId
        ? log.sessionId
        : `run#${index + 1}`;
      const isColdStart = !seenSessions.has(sessionKey) && requestCountInRun === 0;
      if (isColdStart) {
        coldStartRequests += 1;
        if (typeof observation.input === 'number') coldStartInput += observation.input;
        if (typeof observation.cached === 'number') coldStartCached += observation.cached;
      } else {
        steadyRequests += 1;
        if (typeof observation.input === 'number') steadyInput += observation.input;
        if (typeof observation.cached === 'number') steadyCached += observation.cached;
      }
      requestCountInRun += 1;
      seenSessions.add(sessionKey);

      byPurpose.set(purpose, entry);
    }
    if (runComplete && requests.length > 0) uncachedPerRun.push(runUncached);
  }

  // Ledger reconciliation: fold in any observed request the run logs did not list
  // (compaction runs in a detached context). The plan requires every model use to
  // enter the ledger, so an omitted call must be counted, not dropped.
  const unreconciledByKind = new Map();
  let unreconciledCalls = 0;
  if (observed.present) {
    for (const item of observed.observations) {
      if (item.modelRequestId && loggedRequestIds.has(item.modelRequestId)) continue;
      const entry = byPurpose.get(item.requestKind) ?? emptyPurpose();
      entry.calls += 1;
      if (typeof item.input === 'number') {
        entry.input += item.input;
        inputTokens += item.input;
        inputReported += 1;
      }
      if (typeof item.cached === 'number') {
        entry.cached += item.cached;
        cachedTokens += item.cached;
        cachedReported += 1;
      }
      if (typeof item.uncached === 'number') {
        entry.uncached += item.uncached;
        uncachedTokens += item.uncached;
        uncachedReported += 1;
      } else {
        entry.unknownUncached += 1;
      }
      if (item.input === undefined || item.cached === undefined) {
        entry.missingUsage += 1;
        missingUsageRequests += 1;
      }
      byPurpose.set(item.requestKind, entry);
      unreconciledByKind.set(item.requestKind, (unreconciledByKind.get(item.requestKind) ?? 0) + 1);
      unreconciledCalls += 1;
      // A compaction/auxiliary call operates on a session that already exists, so
      // it is steady-state by construction, never a session's cold start.
      steadyRequests += 1;
      if (typeof item.input === 'number') steadyInput += item.input;
      if (typeof item.cached === 'number') steadyCached += item.cached;
    }
  }

  const runs = logs.length;
  const hitRatio = percent(cachedTokens, inputTokens);
  const usageComplete = missingUsageRequests === 0
    && runsWithIncompleteUsage === 0
    && runsWithoutRequests === 0
    && runsWithoutOutputUsage === 0
    && unparsed.length === 0;
  const withinTarget = hitRatio === undefined ? undefined : hitRatio >= HIT_TARGET_PERCENT;
  // Red line is judged on the steady-state figure (acceptance 3.1); the overall
  // figure including cold starts is reported alongside as background.
  const steadyHitRatio = percent(steadyCached, steadyInput);
  const steadyWithinTarget = steadyHitRatio === undefined ? undefined : steadyHitRatio >= HIT_TARGET_PERCENT;
  const coldStartHitRatio = percent(coldStartCached, coldStartInput);
  const rewriteSummary = [...rewrites.entries()].sort((a, b) => a[0] - b[0])
    .map(([value, runsAtValue]) => `${value}x${runsAtValue}`).join(' ');
  const retrySummary = [...retriesByReason.entries()].sort((a, b) => b[1] - a[1])
    .map(([reason, retries]) => `${reason}=${retries}`).join(' ');
  const statusSummary = [...byStatus.entries()].sort((a, b) => b[1] - a[1])
    .map(([status, runsWithStatus]) => `${status}=${runsWithStatus}`).join(' ');

  const purposes = [...byPurpose.entries()].sort((a, b) => b[1].calls - a[1].calls)
    .map(([purpose, entry]) => ({
      purpose,
      calls: entry.calls,
      retries: entry.retries,
      input: entry.input,
      cached: entry.cached,
      uncached: entry.uncached,
      uncachedPerCall: ratio(entry.uncached, entry.calls),
      hitPercent: percent(entry.cached, entry.input),
      requestsWithoutInputUsage: entry.missingUsage,
      requestsWithoutReportedUncached: entry.unknownUncached,
      systemLengths: [...entry.systemLengths.entries()].sort((a, b) => b[1] - a[1])
        .map(([length, callsAtLength]) => `${length}x${callsAtLength}`).join(' '),
    }));

  return {
    sample: basename(dataDir),
    runs,
    requests: requestCount,
    logFiles: files,
    unparsedLogs: unparsed,
    callsPerRun: {
      average: average(callsPerRun),
      p50: percentile(callsPerRun, 50),
      p95: percentile(callsPerRun, 95),
    },
    tokens: {
      input: inputTokens,
      cachedInput: cachedTokens,
      uncachedInput: uncachedTokens,
      output: outputTokens,
      outputRunsReported: outputKnownRuns,
    },
    hitPercent: hitRatio,
    // Acceptance 3.1: the red line is the steady-state figure; the cold-start cost
    // is reported as its own class and the overall figure as background context.
    steadyState: {
      requests: steadyRequests,
      input: steadyInput,
      cachedInput: steadyCached,
      hitPercent: steadyHitRatio,
      withinTarget: usageComplete ? steadyWithinTarget : undefined,
    },
    coldStart: {
      requests: coldStartRequests,
      input: coldStartInput,
      cachedInput: coldStartCached,
      hitPercent: coldStartHitRatio,
    },
    uncachedPerRun: {
      average: average(uncachedPerRun),
      p50: percentile(uncachedPerRun, 50),
      p95: percentile(uncachedPerRun, 95),
      measuredRuns: uncachedPerRun.length,
    },
    uncachedPerCall: ratio(uncachedTokens, requestCount),
    usageCoverage: {
      complete: usageComplete,
      requestsWithoutInputOrCachedUsage: missingUsageRequests,
      requestsWithoutReportedUncached: uncachedDerived,
      runsWithIncompleteUsage,
      runsWithoutRequests,
      runsWithoutOutputUsage,
      inputReportedRequests: inputReported,
      cachedReportedRequests: cachedReported,
      uncachedReportedRequests: uncachedReported,
    },
    ledgerCrossCheck: {
      runUsagePromptTokens,
      runsReportingPromptTokens: runUsagePromptRuns,
      requestPromptTokens: inputTokens,
      delta: runUsagePromptRuns === runs ? inputTokens - runUsagePromptTokens : undefined,
    },
    // Requests present in cache observations but absent from the run logs, such as
    // detached compaction calls. Reported so an incomplete ledger is visible
    // instead of silently shrinking the total.
    observationReconciliation: {
      observationsPresent: observed.present,
      observationFiles: observed.files,
      loggedRequests: requestCount - unreconciledCalls,
      unreconciledRequests: unreconciledCalls,
      unreconciledByKind: Object.fromEntries(unreconciledByKind.entries()),
    },
    target: {
      percent: HIT_TARGET_PERCENT,
      // Judged on the steady-state figure per acceptance 3.1.
      withinTarget: usageComplete ? steadyWithinTarget : undefined,
      conclusion: !usageComplete
        ? 'unavailable (incomplete usage)'
        : (steadyWithinTarget ? 'met' : 'not met'),
      basis: 'steady-state (cold-start requests excluded, all other requests counted)',
      overallHitPercent: hitRatio,
      overallWithinTarget: usageComplete ? withinTarget : undefined,
    },
    runsByStatus: Object.fromEntries(byStatus.entries()),
    failures,
    failedTraceSteps,
    retries: {
      requests: retryRequests,
      byReason: Object.fromEntries(retriesByReason.entries()),
      providerAttempts,
      providerAttemptsPerCall: ratio(providerAttempts, requestCount),
    },
    latency: {
      taskDurationMs: {
        average: average(durations),
        p50: percentile(durations, 50),
        p95: percentile(durations, 95),
      },
      timeToFirstModelRequestMs: {
        measured: firstModelRequestDelays.length,
        average: average(firstModelRequestDelays),
        p50: percentile(firstModelRequestDelays, 50),
        p95: percentile(firstModelRequestDelays, 95),
      },
      timeToFirstToolActionMs: firstToolActionDelays.length === 0
        ? 'unavailable (no tool invocation recorded)'
        : {
            measured: firstToolActionDelays.length,
            runsWithToolActions,
            average: average(firstToolActionDelays),
            p50: percentile(firstToolActionDelays, 50),
            p95: percentile(firstToolActionDelays, 95),
          },
    },
    replyProvenanceRewriteCount: Object.fromEntries(rewrites.entries()),
    purposes,
  };
}

function printSummary(summary) {
  const { usageCoverage: coverage } = summary;
  console.log(`sample: ${summary.sample}`);
  console.log(
    `runs=${summary.runs} model requests=${summary.requests} `
    + `log files=${summary.logFiles} unparsable=${summary.unparsedLogs.length}`,
  );
  console.log(
    `tokens: input=${summary.tokens.input} cached=${summary.tokens.cachedInput} `
    + `uncached=${summary.tokens.uncachedInput} output=${summary.tokens.output}`
    + (summary.tokens.outputRunsReported === summary.runs
      ? ''
      : ` (output reported by ${summary.tokens.outputRunsReported}/${summary.runs} runs)`),
  );
  console.log(
    `hit=${fmt(summary.hitPercent, 3)}% (sum(cached_input)/sum(input)); `
    + `target>=${summary.target.percent}%: ${summary.target.conclusion}`,
  );
  console.log(
    `red line basis: ${summary.target.basis}`,
  );
  console.log(
    `  steady-state: requests=${summary.steadyState.requests} `
    + `input=${summary.steadyState.input} cached=${summary.steadyState.cachedInput} `
    + `hit=${fmt(summary.steadyState.hitPercent, 3)}% `
    + `target>=${summary.target.percent}%: ${summary.steadyState.withinTarget === undefined
      ? 'unavailable (incomplete usage)'
      : (summary.steadyState.withinTarget ? 'met' : 'not met')}`,
  );
  console.log(
    `  cold-start: requests=${summary.coldStart.requests} `
    + `input=${summary.coldStart.input} cached=${summary.coldStart.cachedInput} `
    + `hit=${fmt(summary.coldStart.hitPercent, 3)}% (reported separately, not judged)`,
  );
  console.log(
    `uncached/run=${fmt(summary.uncachedPerRun.average, 1)} `
    + `(p50=${fmt(summary.uncachedPerRun.p50)} p95=${fmt(summary.uncachedPerRun.p95)}); `
    + `uncached/reported-request=${fmt(summary.uncachedPerCall, 1)}`,
  );
  console.log(
    `usage: complete=${coverage.complete ? 'yes' : 'no'} `
    + `requests_without_input_or_cached=${coverage.requestsWithoutInputOrCachedUsage} `
    + `requests_without_reported_uncached=${coverage.requestsWithoutReportedUncached} `
    + `runs_with_incomplete_usage=${coverage.runsWithIncompleteUsage} `
    + `runs_without_requests=${coverage.runsWithoutRequests} `
    + `runs_without_output_usage=${coverage.runsWithoutOutputUsage}`,
  );
  console.log(
    `usage cross-check: run usage.promptTokens=${summary.ledgerCrossCheck.runUsagePromptTokens} `
    + `vs request cache fields=${summary.ledgerCrossCheck.requestPromptTokens} `
    + `delta=${summary.ledgerCrossCheck.delta === undefined ? 'unavailable' : summary.ledgerCrossCheck.delta} `
    + `(runs reporting prompt usage=${summary.ledgerCrossCheck.runsReportingPromptTokens}/${summary.runs})`,
  );
  console.log(
    `runs by status: ${Object.entries(summary.runsByStatus)
      .map(([status, runsWithStatus]) => `${status}=${runsWithStatus}`).join(' ') || 'n/a'}; `
    + `failed trace steps=${summary.failedTraceSteps}`,
  );
  if (summary.failures.length > 0) {
    console.log(`failures: ${summary.failures
      .map((failure) => `${failure.label}:${failure.status}${failure.error ? ` (${failure.error})` : ''}`)
      .join(', ')}`);
  } else {
    console.log('failures: none recorded');
  }
  console.log(
    `retries: requests marked retry=${summary.retries.requests} `
    + `[${Object.entries(summary.retries.byReason).map(([reason, retries]) => `${reason}=${retries}`).join(' ') || 'none'}]; `
    + `provider attempts/call=${fmt(summary.retries.providerAttemptsPerCall, 2)}`,
  );
  console.log(
    `model requests/run: avg=${fmt(summary.callsPerRun.average, 2)} `
    + `p50=${fmt(summary.callsPerRun.p50)} p95=${fmt(summary.callsPerRun.p95)}`,
  );
  console.log(
    `task completion latency: avg=${fmt(summary.latency.taskDurationMs.average)}ms `
    + `p50=${fmt(summary.latency.taskDurationMs.p50)}ms p95=${fmt(summary.latency.taskDurationMs.p95)}ms`,
  );
  const firstRequest = summary.latency.timeToFirstModelRequestMs;
  console.log(
    `time to first model request: n=${firstRequest.measured} avg=${fmt(firstRequest.average)}ms `
    + `p50=${fmt(firstRequest.p50)}ms p95=${fmt(firstRequest.p95)}ms`,
  );
  const firstTool = summary.latency.timeToFirstToolActionMs;
  console.log(typeof firstTool === 'string'
    ? `time to first tool action: ${firstTool}`
    : `time to first tool action: n=${firstTool.measured} avg=${fmt(firstTool.average)}ms `
      + `p50=${fmt(firstTool.p50)}ms p95=${fmt(firstTool.p95)}ms`);
  const rewriteSummary = Object.entries(summary.replyProvenanceRewriteCount)
    .map(([value, runsAtValue]) => `${value}x${runsAtValue}`).join(' ');
  console.log(`replyProvenance rewriteCount (runs): ${rewriteSummary || 'n/a'}`);

  console.log('');
  console.log('per purpose:');
  for (const row of summary.purposes) {
    console.log(
      `  ${row.purpose.padEnd(20)} calls=${String(row.calls).padStart(3)} `
      + `retries=${String(row.retries).padStart(2)} `
      + `uncached/call=${fmt(row.uncachedPerCall, 1).padStart(7)} `
      + `hit=${fmt(row.hitPercent, 1).padStart(5)}% `
      + `missing_usage=${row.requestsWithoutInputUsage} `
      + `unreported_uncached=${row.requestsWithoutReportedUncached} `
      + `system: ${row.systemLengths}`,
    );
  }
}

/**
 * The current red line (2026-09-22): the session-cumulative ratio the DeepSeek
 * Harness front end shows, with detached calls listed separately and H_all
 * covering the whole ledger. Judged on exact values, never on a rounded display.
 */
function sessionLedgerFor(dataDir) {
  const ledger = readLedger(dataDir);
  const projection = projectSessions(ledger);
  return {
    targetPercent: SESSION_HIT_TARGET_PERCENT,
    ...projection,
  };
}

function printSessionLedger(section) {
  console.log('');
  console.log(
    `session-cumulative red line: H_ui = sum(cacheRead)/sum(uncachedInput+cacheRead+cacheWrite), `
    + `cold start included, target>=${section.targetPercent}% (exact value, not the rounded display)`,
  );
  if (section.sessions.length === 0) {
    console.log('  sessions: none (no session-projected request in this sample)');
  }
  for (const session of section.sessions) {
    const projection = session.sessionProjection;
    const verdict = projection.requestsWithoutUsage > 0
      ? 'unavailable (incomplete usage)'
      : (projection.withinTarget ? 'met' : 'not met');
    console.log(
      `  ${session.sessionId}: requests=${projection.requests} input=${projection.input} `
      + `cached=${projection.cached} H_ui=${fmt(projection.hitPercent, 3)}% target: ${verdict}`,
    );
    console.log(
      `    detached auxiliary: requests=${session.auxiliary.requests} `
      + `hit=${fmt(session.auxiliary.hitPercent, 3)}%; H_all(session)=${fmt(session.all.hitPercent, 3)}%`,
    );
    const losses = session.losses;
    if (losses) {
      console.log(
        `    uncached split: coldStart=${losses.coldStart} rebuild=${losses.rebuild} `
        + `appendResidual=${losses.appendResidual} unknownUsage=${losses.unknownUsage} `
        + `(rebuild>=${losses.rebuildThresholdTokens}; residual/request=${fmt(losses.appendResidualPerRequest, 1)} `
        + `median=${fmt(losses.appendResidualMedian, 1)} max=${fmt(losses.appendResidualMax, 1)})`,
      );
      console.log(
        `    measured new content=${losses.newContent}; re-billed reuse waste=${losses.reuseWaste.total} `
        + `(rebuild=${losses.reuseWaste.fromRebuild} append=${losses.reuseWaste.fromAppend})`,
      );
      console.log(
        `    derived bounds: reuseWasteRecovered=${fmt(losses.derivedBounds.reuseWasteRecovered.hitPercent, 3)}% `
        + `coldStartAlsoCached=${fmt(losses.derivedBounds.coldStartAlsoCached.hitPercent, 3)}% `
        + `(models, not measurements)`,
      );
      for (const event of losses.rebuildEvents.slice(0, 8)) {
        console.log(
          `      rebuild@${event.ordinal} run=${event.runId ?? 'n/a'} uncached=${event.uncached} `
          + `components=[${event.changedComponents.join(', ') || 'none'}] `
          + `reasons=[${event.invalidationReasons.join(', ') || 'none'}] `
          + `stablePrefixChanged=${event.stablePrefixFingerprintChanged}`,
        );
      }
    }
    for (const node of session.nodes ?? []) {
      console.log(
        `    node ${String(node.id).padEnd(16)} turn=${node.turn} `
        + `H_ui=${fmt(node.hitPercent, 3)}% ${node.withinTarget === undefined
          ? `(${node.availability})`
          : (node.withinTarget ? 'met' : 'NOT MET')}`,
      );
    }
    const judged = judgeNodes(session.nodes ?? []);
    if (judged.failures.length > 0) {
      console.log(`    nodes below target: ${judged.failures
        .map((failure) => `${failure.id}(${failure.reason})`).join(', ')}`);
    }
  }
  console.log(
    `  whole-ledger H_all: requests=${section.ledger.requests} input=${section.ledger.input} `
    + `cached=${section.ledger.cached} hit=${fmt(section.ledger.hitPercent, 3)}%`,
  );
  if (section.unattributed.requests > 0) {
    console.log(
      `  unattributed detached calls: requests=${section.unattributed.requests} `
      + `input=${section.unattributed.input} (kept inside H_all)`,
    );
  }
  const coverage = section.coverage;
  console.log(
    `  ledger coverage: runs=${coverage.runCount} unparsable_logs=${coverage.unparsedLogs.length} `
    + `detached_observations=${coverage.detachedObservations} `
    + `requests_without_usage=${coverage.requestsWithoutUsage} `
    + `runs_with_incomplete_usage=${coverage.runsWithIncompleteUsage}`,
  );
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const sessions = args.includes('--sessions');
const operands = args.filter((arg) => arg !== '--json' && arg !== '--sessions');
if (operands.length === 0) {
  console.error(USAGE);
  process.exitCode = 1;
} else if (operands[0] === '--latest') {
  const dir = latestSampleDir();
  if (!dir) {
    console.error('audit-cache-usage: no sample directory found under the temp root');
    process.exitCode = 1;
  } else {
    const summary = audit(dir);
    if (summary) {
      const section = sessions ? sessionLedgerFor(dir) : undefined;
      if (json) console.log(JSON.stringify({ ...summary, ...(section ? { sessionLedger: section } : {}) }, null, 2));
      else {
        printSummary(summary);
        if (section) printSessionLedger(section);
      }
    }
  }
} else {
  const summaries = [];
  for (const dir of operands) {
    const summary = audit(dir);
    if (!summary) continue;
    summaries.push(summary);
    const section = sessions ? sessionLedgerFor(dir) : undefined;
    if (json) console.log(JSON.stringify({ ...summary, ...(section ? { sessionLedger: section } : {}) }, null, 2));
    else {
      printSummary(summary);
      if (section) printSessionLedger(section);
      console.log('');
    }
  }
  if (!json && summaries.length > 1) {
    const runs = sum(summaries.map((summary) => summary.runs));
    const requests = sum(summaries.map((summary) => summary.requests));
    const input = sum(summaries.map((summary) => summary.tokens.input));
    const cached = sum(summaries.map((summary) => summary.tokens.cachedInput));
    const uncached = sum(summaries.map((summary) => summary.tokens.uncachedInput));
    const output = sum(summaries.map((summary) => summary.tokens.output));
    const missing = sum(summaries.map((summary) => summary.usageCoverage.requestsWithoutInputOrCachedUsage));
    console.log(`combined: samples=${summaries.length} runs=${runs} requests=${requests}`);
    console.log(`combined tokens: input=${input} cached=${cached} uncached=${uncached} output=${output}`);
    console.log(
      `combined hit=${fmt(percent(cached, input), 3)}%; `
      + `usage complete=${missing === 0 ? 'yes' : 'no'} (requests without input/cached usage=${missing})`,
    );
  }
}
