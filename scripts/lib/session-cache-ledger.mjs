// Session-cumulative cache ledger (acceptance "真实长任务现行红线", 2026-09-22).
//
// The red line is the ratio the DeepSeek Harness front end shows for a session:
//
//   H_ui = Σ cacheRead / Σ (uncachedInput + cacheRead + cacheWrite)
//
// verified against dsh commit ddefc45:
//   - packages/llm/token-meter/src/usage-projection.ts folds assistant/message
//     and assistant/attempt usage into one session-wide `tokenUsage` total, and
//     `llm/retry-started` makes a retried attempt add instead of replace.
//   - packages/client/ui-chat/.../StatsPills.tsx divides cacheReadTokens by
//     billedInputTokens() = uncached + cacheRead + cacheWrite, with no cold-start
//     exclusion and no averaging of per-request percentages.
//
// This module answers the same question for one LittleSheep data root from the
// production ledger only (execution logs + cache observations). It never invents
// numbers: a request whose provider usage is missing stays `unavailable`, is
// counted, and keeps its reason.
//
// Two kinds of missing usage are not the same thing, and the report says which:
//   - `provider_request_failed` is an attempt the Provider never answered (a
//     dropped connection mid-run). It carries no measured prompt, so it adds no
//     input and hides none; the retry that answered is the measured request. The
//     gap is disclosed and the node keeps its verdict.
//   - anything else is a request that was answered without usage being recorded.
//     That is a hole in the measurement itself, so the affected node has no verdict
//     and can never be reported as passing.
//
// Attribution rule (which calls belong to a session's own turns):
//   - a request recorded in a run log of the session, whose purpose publishes a
//     conversation turn, enters H_ui;
//   - a detached call that never publishes a session turn (compaction is the only
//     live one) is listed separately and enters H_all only;
//   - an observation that cannot be tied to a session is reported as unattributed
//     auxiliary usage inside H_all, never dropped.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const HIT_TARGET_PERCENT = 95;
export const HIT_TARGET_CEILING_PERCENT = 99.5;

/**
 * Purposes whose request settles as a conversation turn in the session. The
 * historical entries keep old samples under the same accounting: those stages
 * were conversation turns before the lean rework deleted them.
 */
export const SESSION_TURN_PURPOSES = Object.freeze(new Set([
  'execute_tool_loop',
  'reply',
  'capability_reply',
  'ask_user',
  'classify',
  'decide',
  'decide_explicit_tool',
  'verify',
  'recover',
  'evolve',
  'capture',
  'execute_final_reply',
]));

/** Detached calls that run outside the session's main projection. */
export const AUXILIARY_PURPOSES = Object.freeze(new Set([
  'session_compaction',
]));

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function percent(numerator, denominator) {
  return denominator === 0 ? undefined : (numerator / denominator) * 100;
}

function promptBuckets(prompt) {
  if (!prompt || typeof prompt !== 'object') return { input: undefined, cached: undefined, uncached: undefined };
  const input = count(prompt.tokenCount);
  const cached = count(prompt.cachedTokenCount);
  const reportedUncached = count(prompt.uncachedTokenCount);
  const uncached = reportedUncached ?? (input !== undefined && cached !== undefined
    ? Math.max(0, input - cached)
    : undefined);
  return { input, cached, uncached };
}

function projectionOf(purpose) {
  if (SESSION_TURN_PURPOSES.has(purpose)) return 'session';
  if (AUXILIARY_PURPOSES.has(purpose)) return 'auxiliary';
  return 'unattributed';
}

function listJson(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function timeOf(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** The stable-prefix composition facts one observation publishes for attribution. */
function diagnosticsOf(observation) {
  return {
    storedAt: observation.storedAt,
    stablePrefixFingerprint: observation.stablePrefixFingerprint,
    stablePrefixBytes: observation.stablePrefixBytes,
    normalizedRequestBytes: observation.normalizedRequestBytes,
    invalidationReasons: observation.invalidationReasons,
    promptComponents: observation.promptComponents,
  };
}

/**
 * Uncached input at or above this many tokens cannot be the Provider's block
 * residual (measured ~128–256 tokens on live DeepSeek runs), so it is treated as
 * a rebuilt prompt rather than an append. The threshold is declared here, before
 * any run, and the measured distribution is reported next to it.
 */
export const REBUILD_THRESHOLD_TOKENS = 1024;

/** Component names whose fingerprint differs between two requests. */
export function changedComponents(previous, current) {
  const before = previous?.diagnostics?.promptComponents;
  const after = current?.diagnostics?.promptComponents;
  if (!before || !after) return [];
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => before[name] !== after[name]).sort();
}

function medianOf(values) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Rank where a session's uncached input came from, using measured tokens first:
 * the session's first request (cold start), requests whose uncached input is too
 * large to be block residual (a rebuilt prompt), and the rest (append residual).
 * Recorded diagnostics — changed prompt-component fingerprints, Provider
 * invalidation reasons, stable-prefix fingerprint movement — are attached as
 * explanations, never as proof that the whole prompt was re-billed: live samples
 * show `prompt_version_changed` on requests that still hit the cache almost
 * fully (~190 uncached tokens).
 */
export function attributeLosses(rows) {
  const buckets = { coldStart: 0, rebuild: 0, appendResidual: 0, unknownUsage: 0 };
  const rebuildEvents = [];
  let previous;
  let measured = 0;
  let input = 0;
  let cached = 0;
  const residualSamples = [];
  // Recoverable loss: for every step after the first, the prompt grows by the new
  // content it appends; anything uncached beyond that growth was already sent in
  // the previous request and was re-billed. Growth is measured from the recorded
  // prompts, so this needs no assumption about what the content was.
  let newContent = 0;
  let reuseWaste = 0;
  let reuseWasteFromRebuild = 0;
  let reuseWasteFromAppend = 0;
  for (const [index, row] of rows.entries()) {
    const known = row.input !== undefined && row.cached !== undefined;
    const uncached = known ? (row.uncached ?? Math.max(0, row.input - row.cached)) : undefined;
    if (known) {
      input += row.input;
      cached += row.cached;
      measured += 1;
    }
    if (uncached === undefined) {
      buckets.unknownUsage += 1;
      previous = row;
      continue;
    }
    if (index === 0) {
      buckets.coldStart += uncached;
    } else {
      const growth = row.input !== undefined && previous?.input !== undefined
        ? row.input - previous.input
        : undefined;
      const appended = growth === undefined ? 0 : Math.max(0, growth);
      const waste = Math.max(0, uncached - appended);
      newContent += appended;
      reuseWaste += waste;
      if (uncached >= REBUILD_THRESHOLD_TOKENS) {
        const changed = changedComponents(previous, row);
        const reasons = row.diagnostics?.invalidationReasons ?? [];
        buckets.rebuild += uncached;
        reuseWasteFromRebuild += waste;
        rebuildEvents.push({
          ordinal: index + 1,
          runId: row.runId,
          purpose: row.purpose,
          input: row.input,
          previousInput: previous?.input,
          promptGrowth: growth,
          uncached,
          reuseWaste: waste,
          changedComponents: changed,
          invalidationReasons: reasons,
          stablePrefixFingerprintChanged: Boolean(previous?.diagnostics?.stablePrefixFingerprint)
            && previous?.diagnostics?.stablePrefixFingerprint !== row.diagnostics?.stablePrefixFingerprint,
        });
      } else {
        buckets.appendResidual += uncached;
        reuseWasteFromAppend += waste;
        residualSamples.push(uncached);
      }
    }
    previous = row;
  }
  return {
    ...buckets,
    rebuildThresholdTokens: REBUILD_THRESHOLD_TOKENS,
    measuredRequests: measured,
    appendResidualPerRequest: residualSamples.length > 0
      ? buckets.appendResidual / residualSamples.length
      : undefined,
    appendResidualMedian: medianOf(residualSamples),
    appendResidualMax: residualSamples.length > 0 ? Math.max(...residualSamples) : undefined,
    rebuildEvents,
    // Measured decomposition of everything the session paid uncached.
    newContent,
    reuseWaste: {
      total: reuseWaste,
      fromRebuild: reuseWasteFromRebuild,
      fromAppend: reuseWasteFromAppend,
    },
    // Derived bounds, never measurements: what the same requests would have shown
    // had no token been re-billed (cached grows by the waste, input is unchanged),
    // and the same with the session's cold start also served from cache.
    derivedBounds: {
      reuseWasteRecovered: {
        input,
        cached: cached + reuseWaste,
        hitPercent: percent(cached + reuseWaste, input),
      },
      coldStartAlsoCached: {
        input,
        cached: cached + reuseWaste + buckets.coldStart,
        hitPercent: percent(cached + reuseWaste + buckets.coldStart, input),
      },
      derived: true,
    },
  };
}

/**
 * Read every model request of a data root with the attribution the red line
 * needs, in chronological order, plus the ledger gaps that make a conclusion
 * unavailable.
 */
export function readLedger(dataDir) {
  const logsDir = join(dataDir, 'execution-logs');
  const observationsDir = join(dataDir, 'cache-observations');

  const runs = [];
  const unparsedLogs = [];
  for (const name of listJson(logsDir)) {
    try {
      runs.push({ name, log: readJson(join(logsDir, name)) });
    } catch {
      unparsedLogs.push(name);
    }
  }
  runs.sort((left, right) => (timeOf(left.log.startedAt) ?? 0) - (timeOf(right.log.startedAt) ?? 0));

  const observations = [];
  const unparsedObservations = [];
  for (const name of listJson(observationsDir)) {
    try {
      const raw = readJson(join(observationsDir, name));
      const observation = raw?.observation ?? raw;
      observations.push({
        name,
        storedAt: typeof raw?.storedAt === 'string' ? raw.storedAt : undefined,
        requestKind: typeof observation?.requestKind === 'string' ? observation.requestKind : 'unknown',
        modelRequestId: typeof observation?.modelRequestId === 'string' ? observation.modelRequestId : undefined,
        sessionDigest: typeof observation?.scope?.sessionDigest === 'string'
          ? observation.scope.sessionDigest
          : undefined,
        stablePrefixFingerprint: typeof observation?.stablePrefix?.fingerprint === 'string'
          ? observation.stablePrefix.fingerprint
          : undefined,
        stablePrefixBytes: count(observation?.stablePrefix?.byteLength),
        normalizedRequestBytes: count(observation?.normalizedRequest?.byteLength),
        invalidationReasons: Array.isArray(observation?.invalidationReasons)
          ? observation.invalidationReasons.filter((reason) => typeof reason === 'string')
          : [],
        promptComponents: observation?.promptComponents && typeof observation.promptComponents === 'object'
          ? observation.promptComponents
          : undefined,
        buckets: promptBuckets(observation?.providerPrompt),
      });
    } catch {
      unparsedObservations.push(name);
    }
  }
  const observationsById = new Map();
  for (const observation of observations) {
    if (observation.modelRequestId) observationsById.set(observation.modelRequestId, observation);
  }

  const requests = [];
  const digestBySession = new Map();
  const reconciledObservationNames = new Set();
  let runsWithIncompleteUsage = 0;
  let runsWithoutRequests = 0;
  for (const [index, { log }] of runs.entries()) {
    const sessionId = typeof log.sessionId === 'string' && log.sessionId ? log.sessionId : undefined;
    const runId = typeof log.runId === 'string' ? log.runId : undefined;
    const runRequests = Array.isArray(log.modelRequests) ? log.modelRequests : [];
    if (runRequests.length === 0) runsWithoutRequests += 1;
    if (log.usage && log.usage.usageCompleteness !== 'complete') runsWithIncompleteUsage += 1;
    for (const request of runRequests) {
      const purpose = request.callContract?.purpose ?? 'unknown';
      const requestId = typeof request.id === 'string' ? request.id : undefined;
      const observation = requestId ? observationsById.get(requestId) : undefined;
      if (observation) {
        reconciledObservationNames.add(observation.name);
        if (observation.sessionDigest && sessionId) digestBySession.set(observation.sessionDigest, sessionId);
      }
      const buckets = observation?.buckets ?? promptBuckets(request.cacheObservation?.providerPrompt);
      // Why a request has no provider usage decides what the gap means: a request
      // the provider never answered (`provider_request_failed`) has no usage by
      // construction, while a successful request whose usage is absent is a real
      // measurement gap. Both stay counted and uncounted-for-input; only the first
      // is expected in a long session.
      const prompt = request.cacheObservation?.providerPrompt;
      const usageGapReason = buckets.input === undefined
        ? (typeof prompt?.reason === 'string' && prompt.reason
          ? prompt.reason
          : (prompt?.status === 'unavailable' ? 'provider_usage_unavailable' : 'provider_usage_absent'))
        : undefined;
      requests.push({
        source: 'run-log',
        sessionId,
        runId,
        runIndex: index + 1,
        requestId,
        createdAt: typeof request.createdAt === 'string' ? request.createdAt : undefined,
        purpose,
        retryOf: typeof request.retryOf === 'string' ? request.retryOf : undefined,
        projection: projectionOf(purpose),
        // The request's own size, independent of the provider's report. Used to
        // check whether a reported prompt that shrank actually came from a smaller
        // request.
        ...(typeof request.totalMessageCount === 'number' ? { requestMessages: request.totalMessageCount } : {}),
        ...(usageGapReason ? { usageGapReason } : {}),
        ...buckets,
        ...(observation ? { diagnostics: diagnosticsOf(observation) } : {}),
      });
    }
  }

  const detachedObservations = observations.filter((observation) => (
    !observation.modelRequestId || !reconciledObservationNames.has(observation.name)
  ));
  for (const observation of detachedObservations) {
    const projection = projectionOf(observation.requestKind);
    requests.push({
      source: 'observation-only',
      // A detached call is attributed to its session through the scope digest the
      // session's own requests already published.
      sessionId: observation.sessionDigest ? digestBySession.get(observation.sessionDigest) : undefined,
      sessionDigest: observation.sessionDigest,
      requestId: observation.modelRequestId,
      purpose: observation.requestKind,
      // Compaction never publishes a session turn, so its usage stays auxiliary
      // even though its purpose would classify as a turn in another context.
      projection: projection === 'session' ? 'auxiliary' : projection,
      ...observation.buckets,
    });
  }

  requests.sort((left, right) => {
    const at = timeOf(left.createdAt);
    const bt = timeOf(right.createdAt);
    if (at === undefined || bt === undefined) return 0;
    return at - bt;
  });

  return {
    requests,
    runs: runs.map((entry) => entry.log),
    digestBySession,
    coverage: {
      logFiles: runs.length + unparsedLogs.length,
      runCount: runs.length,
      unparsedLogs,
      observationFiles: observations.length + unparsedObservations.length,
      unparsedObservations,
      reconciledObservations: reconciledObservationNames.size,
      detachedObservations: detachedObservations.length,
      runsWithIncompleteUsage,
      runsWithoutRequests,
      requestsWithoutUsage: requests.filter((row) => row.input === undefined || row.cached === undefined).length,
    },
  };
}

/** Round-trip one bucket group; unknown usage is counted, never zero-filled. */
export function totalsOf(rows) {
  let input = 0;
  let cached = 0;
  let uncached = 0;
  let measured = 0;
  let unavailable = 0;
  let failedRequests = 0;
  const unavailableByReason = {};
  for (const row of rows) {
    if (row.input === undefined || row.cached === undefined) {
      unavailable += 1;
      const reason = row.usageGapReason ?? 'provider_usage_absent';
      unavailableByReason[reason] = (unavailableByReason[reason] ?? 0) + 1;
      if (reason === 'provider_request_failed') failedRequests += 1;
      continue;
    }
    input += row.input;
    cached += row.cached;
    uncached += row.uncached ?? Math.max(0, row.input - row.cached);
    measured += 1;
  }
  const hitPercent = percent(cached, input);
  const usageMissing = unavailable - failedRequests;
  return {
    requests: rows.length,
    measuredRequests: measured,
    requestsWithoutUsage: unavailable,
    // A request the provider never answered has no usage by construction; a
    // successful request without usage is a gap in the measurement itself. The
    // ratio stays a ratio of the measured prompts either way, but which of the two
    // is present decides whether a conclusion may be drawn from it.
    failedRequests,
    usageMissing,
    requestsWithoutUsageByReason: unavailableByReason,
    measurement: unavailable === 0 ? 'complete' : (usageMissing === 0 ? 'complete-except-failed-attempts' : 'incomplete'),
    input,
    cached,
    uncached,
    // DeepSeek reports no cache writes, so the bucket is an explicit 0 and the
    // denominator is the three disjoint prompt-side buckets.
    cacheWrite: 0,
    billedInput: input,
    hitPercent,
    withinTarget: hitPercent === undefined ? undefined : hitPercent >= HIT_TARGET_PERCENT,
    aboveCeiling: hitPercent === undefined ? undefined : hitPercent > HIT_TARGET_CEILING_PERCENT,
  };
}

function cumulativeCurve(rows) {
  const curve = [];
  let input = 0;
  let cached = 0;
  for (const [index, row] of rows.entries()) {
    if (row.input !== undefined && row.cached !== undefined) {
      input += row.input;
      cached += row.cached;
    }
    const hitPercent = percent(cached, input);
    curve.push({
      ordinal: index + 1,
      createdAt: row.createdAt,
      runId: row.runId,
      purpose: row.purpose,
      input: row.input,
      cached: row.cached,
      uncached: row.uncached,
      availability: row.input === undefined || row.cached === undefined ? 'unavailable' : 'reported',
      cumulativeInput: input,
      cumulativeCached: cached,
      cumulativeHitPercent: hitPercent,
    });
  }
  return curve;
}

/** A reported prompt this much smaller than the previous one is not block residual. */
const PROVIDER_SHRINK_THRESHOLD_TOKENS = 500;

/**
 * Requests whose provider report contradicts the request the Runtime recorded.
 *
 * The signature: the provider reports a prompt at least 500 tokens *smaller* than
 * the previous measured request in the session, while the request's own recorded
 * size (`totalMessageCount`) did not shrink. A transcript that grew cannot produce
 * a smaller prompt, so the two records disagree. Both readings are possible — the
 * provider's cache missed the prefix, or its usage report is wrong — and this
 * module does not decide which; it counts the event, publishes the samples and
 * offers the sensitivity view, so a conclusion can say how much of the loss sits
 * behind a report the Runtime cannot corroborate.
 *
 * Measured on the 28-turn long task (2026-09-22): seven such requests carried
 * 66,539 of 153,022 uncached tokens (43%), and one had grown from 34 to 37
 * messages (`messagesTruncated: false`) while the report fell from 10,150 to 8,429.
 */
export function detectProviderUsageInconsistencies(rows) {
  const requestIds = new Set();
  const samples = [];
  let inputDelta = 0;
  let uncached = 0;
  let previous;
  for (const row of rows) {
    if (row.input === undefined || row.cached === undefined) continue;
    if (previous
      && row.input < previous.input - PROVIDER_SHRINK_THRESHOLD_TOKENS
      && (row.requestMessages ?? 0) >= (previous.requestMessages ?? 0)) {
      requestIds.add(row.requestId);
      inputDelta += previous.input - row.input;
      uncached += row.uncached ?? 0;
      if (samples.length < 5) {
        samples.push({
          requestId: row.requestId,
          runIndex: row.runIndex,
          purpose: row.purpose,
          input: row.input,
          previousInput: previous.input,
          cached: row.cached,
          requestMessages: row.requestMessages,
          previousRequestMessages: previous.requestMessages,
        });
      }
    }
    previous = row;
  }
  return {
    kind: 'provider_report_smaller_than_request',
    requestIds,
    count: requestIds.size,
    inputDeltaTokens: inputDelta,
    uncachedTokens: uncached,
    samples,
  };
}

function groupByPurpose(rows) {
  const byPurpose = new Map();
  for (const row of rows) {
    byPurpose.set(row.purpose, [...(byPurpose.get(row.purpose) ?? []), row]);
  }
  return [...byPurpose.entries()]
    .map(([purpose, purposeRows]) => ({ purpose, ...totalsOf(purposeRows) }))
    .sort((left, right) => right.requests - left.requests || left.purpose.localeCompare(right.purpose));
}

/**
 * Cumulative value at each pre-frozen turn node. `turns` is the driver's frozen
 * plan (`[{ turn, id, label, runId }]`): a node reports the cumulative ratio
 * through the last request of that turn, so a turn that never ran is reported as
 * missing instead of silently shrinking the sum.
 */
export function evaluateTurnNodes(turnRows, turns) {
  const rowsByRun = new Map();
  for (const row of turnRows) {
    if (!row.runId) continue;
    rowsByRun.set(row.runId, [...(rowsByRun.get(row.runId) ?? []), row]);
  }
  const consumed = [];
  const nodes = [];
  for (const turn of [...turns].sort((left, right) => left.turn - right.turn)) {
    const rows = rowsByRun.get(turn.runId) ?? [];
    consumed.push(...rows);
    const totals = totalsOf(consumed);
    // A node whose answered requests all reported usage has a verdict even if the
    // provider failed an attempt inside the turn: a failed request carries no
    // measured prompt, so it neither adds input nor hides a measured one. Only a
    // successful request without usage makes the reading incomplete.
    const complete = rows.length > 0 && totals.usageMissing === 0;
    nodes.push({
      id: turn.id ?? `turn-${turn.turn}`,
      turn: turn.turn,
      label: turn.label,
      runId: turn.runId,
      requestsInTurn: rows.length,
      cumulativeRequests: totals.requests,
      input: totals.input,
      cached: totals.cached,
      uncached: totals.uncached,
      hitPercent: totals.hitPercent,
      withinTarget: complete ? totals.withinTarget : undefined,
      availability: complete ? 'complete' : 'incomplete',
      // Failed provider attempts inside the turn are reported so the reading is
      // never silently narrower than the session.
      failedRequests: totals.failedRequests,
      usageMissing: totals.usageMissing,
      missingTurnRequests: rows.length === 0,
    });
  }
  return nodes;
}

/** Judge the frozen long-task nodes; incomplete usage can never pass. */
export function judgeNodes(nodes, target = HIT_TARGET_PERCENT) {
  const failures = nodes.filter((node) => node.availability !== 'complete'
    || node.hitPercent === undefined
    || node.hitPercent < target);
  return {
    target,
    conclusion: nodes.length === 0 ? 'unavailable (no frozen node evaluated)' : (failures.length === 0 ? 'met' : 'not met'),
    failures: failures.map((node) => ({
      id: node.id,
      turn: node.turn,
      hitPercent: node.hitPercent,
      reason: node.availability !== 'complete' ? 'incomplete usage' : 'below target',
    })),
    // A turn where the provider failed an attempt still has a verdict; the count is
    // published so the reader knows the session was not perfectly clean.
    failedAttempts: nodes.reduce((sum, node) => sum + (node.failedRequests ?? 0), 0),
    aboveCeiling: nodes.filter((node) => node.hitPercent !== undefined
      && node.hitPercent > HIT_TARGET_CEILING_PERCENT).map((node) => node.id),
  };
}

/**
 * Project one ledger into the session-cumulative red line: H_ui per session, the
 * detached auxiliary calls listed separately, and H_all over the whole ledger.
 * `turnsBySession` is the frozen turn plan produced by the task driver.
 */
export function projectSessions(ledger, { turnsBySession } = {}) {
  const sessions = new Map();
  const ensure = (sessionId) => {
    if (!sessions.has(sessionId)) sessions.set(sessionId, { sessionId, turnRows: [], auxiliaryRows: [] });
    return sessions.get(sessionId);
  };
  const unattributedRows = [];
  for (const row of ledger.requests) {
    if (row.projection === 'session' && row.sessionId) {
      ensure(row.sessionId).turnRows.push(row);
      continue;
    }
    if (row.sessionId) {
      ensure(row.sessionId).auxiliaryRows.push(row);
      continue;
    }
    unattributedRows.push(row);
  }

  const projected = [...sessions.values()]
    .map((session) => {
      const sessionProjection = totalsOf(session.turnRows);
      const auxiliary = totalsOf(session.auxiliaryRows);
      const turns = turnsBySession?.[session.sessionId];
      const inconsistencies = detectProviderUsageInconsistencies(session.turnRows);
      return {
        sessionId: session.sessionId,
        firstRequestAt: session.turnRows[0]?.createdAt,
        requestCurve: cumulativeCurve(session.turnRows),
        sessionProjection,
        losses: attributeLosses(session.turnRows),
        auxiliary,
        auxiliaryByPurpose: groupByPurpose(session.auxiliaryRows),
        all: totalsOf([...session.turnRows, ...session.auxiliaryRows]),
        nodes: turns ? evaluateTurnNodes(session.turnRows, turns) : undefined,
        inconsistencies,
        // A sensitivity view, not a second verdict: what the ratio is when the
        // requests whose provider report contradicts the request itself are left
        // out. The primary ratio above always stays the whole ledger.
        sessionProjectionWithoutInconsistencies: totalsOf(
          session.turnRows.filter((row) => !inconsistencies.requestIds.has(row.requestId)),
        ),
      };
    })
    .sort((left, right) => (left.firstRequestAt ?? '').localeCompare(right.firstRequestAt ?? ''));

  const unattributed = totalsOf(unattributedRows);
  return {
    sessions: projected,
    unattributed,
    unattributedByPurpose: groupByPurpose(unattributedRows),
    ledger: totalsOf(ledger.requests),
    ledgerByPurpose: groupByPurpose(ledger.requests),
    ledgerByProjection: groupByPurpose(ledger.requests.map((row) => ({ ...row, purpose: row.projection }))),
    coverage: ledger.coverage,
  };
}

/** One-line summary used by scripts and reports; never rounds a red line up. */
export function summarizeSessions(projection) {
  return projection.sessions.map((session) => ({
    sessionId: session.sessionId,
    requests: session.sessionProjection.requests,
    hitPercent: session.sessionProjection.hitPercent,
    withinTarget: session.sessionProjection.requestsWithoutUsage === 0
      ? session.sessionProjection.withinTarget
      : undefined,
    auxiliaryRequests: session.auxiliary.requests,
    auxiliaryHitPercent: session.auxiliary.hitPercent,
    allHitPercent: session.all.hitPercent,
    nodes: session.nodes?.map((node) => ({
      id: node.id,
      hitPercent: node.hitPercent,
      withinTarget: node.withinTarget,
      availability: node.availability,
    })),
  }));
}
