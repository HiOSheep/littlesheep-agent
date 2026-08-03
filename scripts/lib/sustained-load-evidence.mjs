export const FORMAL_DEFAULT_DURATION_SECONDS = 2 * 60 * 60
export const FORMAL_MAX_DURATION_SECONDS = 6 * 60 * 60

const TREND_WINDOW_COUNT = 24
const FORMAL_SLOPE_BUDGET_PER_HOUR = {
  rssBytes: 64 * 1024 * 1024,
  heapUsedBytes: 32 * 1024 * 1024,
  electronWorkingSetBytes: 128 * 1024 * 1024,
  electronPrivateBytes: 128 * 1024 * 1024,
  activeHandleCount: 4,
  activeRequestCount: 2,
  electronProcessCount: 0.5,
}

export function parseSustainedLoadOptions(args) {
  const values = {
    mode: 'diagnostic',
    durationSeconds: undefined,
    sampleIntervalMs: undefined,
    progressIntervalMs: undefined,
  }
  for (const arg of args) {
    const [name, rawValue] = arg.split('=', 2)
    if (name === '--mode' && (rawValue === 'diagnostic' || rawValue === 'formal')) values.mode = rawValue
    else if (name === '--duration-seconds') values.durationSeconds = Number(rawValue)
    else if (name === '--sample-ms') values.sampleIntervalMs = boundedInteger(rawValue, 250, 60_000, name)
    else if (name === '--progress-ms') values.progressIntervalMs = boundedInteger(rawValue, 250, 60_000, name)
    else throw new Error(`unsupported argument: ${arg}`)
  }
  const formal = values.mode === 'formal'
  return {
    mode: values.mode,
    durationSeconds: boundedInteger(
      values.durationSeconds ?? (formal ? FORMAL_DEFAULT_DURATION_SECONDS : 120),
      formal ? 60 * 60 : 15,
      formal ? FORMAL_MAX_DURATION_SECONDS : 1_200,
      '--duration-seconds',
    ),
    sampleIntervalMs: values.sampleIntervalMs ?? (formal ? 5_000 : 1_000),
    progressIntervalMs: values.progressIntervalMs ?? (formal ? 5_000 : 1_000),
  }
}

export function createSustainedResourceAggregate(expectations) {
  const metricNames = [
    'rssBytes',
    'heapUsedBytes',
    'activeHandleCount',
    'activeRequestCount',
    'electronWorkingSetBytes',
    'electronPrivateBytes',
    'electronProcessCount',
    'activeRunCount',
    'retiredRunnerCount',
    'sourceCount',
    'listenerCount',
    'progressTick',
  ]
  const minimum = Object.fromEntries(metricNames.map((name) => [name, Number.POSITIVE_INFINITY]))
  const maximum = Object.fromEntries(metricNames.map((name) => [name, Number.NEGATIVE_INFINITY]))
  let first
  let last
  let count = 0
  let previousTick = -1
  let missingProgressSamples = 0
  const violations = []
  const trend = createTrendAggregate(expectations)
  return {
    add(snapshot, progress) {
      const progressTick = Number.isSafeInteger(progress?.tick) && progress.tick >= 0
        ? progress.tick
        : undefined
      if (progressTick === undefined) missingProgressSamples += 1
      const sample = flattenSample(snapshot, progress, previousTick >= 0 ? previousTick : 0)
      if (!first) first = sample
      last = sample
      count += 1
      for (const name of metricNames) {
        const value = sample[name]
        if (!Number.isFinite(value) || value < 0) rememberViolation(`${name} is invalid: ${value}`)
        minimum[name] = Math.min(minimum[name], value)
        maximum[name] = Math.max(maximum[name], value)
      }
      if (progressTick !== undefined) {
        if (progressTick < previousTick) {
          rememberViolation(`progress tick regressed from ${previousTick} to ${progressTick}`)
        }
        previousTick = Math.max(previousTick, progressTick)
      }
      if (sample.activeRunCount > 1) rememberViolation(`active run count exceeded 1: ${sample.activeRunCount}`)
      if (sample.sourceCount > expectations.maxSourceCount) rememberViolation(`activity source count exceeded ${expectations.maxSourceCount}: ${sample.sourceCount}`)
      if (sample.retiredRunnerCount > expectations.maxRetiredRunnerCount) rememberViolation(`retired runner count exceeded ${expectations.maxRetiredRunnerCount}: ${sample.retiredRunnerCount}`)
      if (sample.listenerCount > expectations.expectedListenerCount) rememberViolation(`activity listener count exceeded ${expectations.expectedListenerCount}: ${sample.listenerCount}`)
      trend.add(sample)
    },
    assertHealthy() {
      if (count < 2) throw new Error(`sustained sampling retained too few aggregate samples: ${count}`)
      if (violations.length > 0) throw new Error(`sustained resource sampling failed: ${safe(violations)}`)
      trend.assertHealthy()
    },
    summary() {
      return {
        sampleCount: count,
        first,
        last,
        minimum,
        maximum,
        violations,
        missingProgressSamples,
        trend: trend.summary(),
      }
    },
  }

  function rememberViolation(message) {
    if (violations.length < 16 && !violations.includes(message)) violations.push(message)
  }
}

function flattenSample(snapshot, progress, fallbackProgressTick = 0) {
  return {
    sampledAt: snapshot.sampledAt,
    rssBytes: snapshot.process.rssBytes,
    heapUsedBytes: snapshot.process.heapUsedBytes,
    activeHandleCount: snapshot.process.activeHandleCount,
    activeRequestCount: snapshot.process.activeRequestCount,
    electronWorkingSetBytes: snapshot.electron.workingSetBytes,
    electronPrivateBytes: snapshot.electron.privateBytes,
    electronProcessCount: snapshot.electron.processCount,
    activeRunCount: snapshot.runtime.aggregatedActiveRunCount,
    retiredRunnerCount: snapshot.runtime.retiredRunnerCount,
    sourceCount: snapshot.runtime.activitySourceCount,
    listenerCount: snapshot.runtime.activityListenerCount,
    // A progress file can be observed during its brief rewrite window. Keep
    // the last known tick for the resource trend; final artifact checks still
    // validate the complete tick count and execution result.
    progressTick: Number.isSafeInteger(progress?.tick) && progress.tick >= 0
      ? progress.tick
      : fallbackProgressTick,
  }
}

function createTrendAggregate(options) {
  const metricNames = [
    'rssBytes',
    'heapUsedBytes',
    'electronWorkingSetBytes',
    'electronPrivateBytes',
    'activeHandleCount',
    'activeRequestCount',
    'electronProcessCount',
  ]
  const windowDurationMs = Math.max(1_000, Math.ceil(options.durationMs / TREND_WINDOW_COUNT))
  const windows = new Map()

  return {
    add(sample) {
      const sampledAtMs = Date.parse(sample.sampledAt)
      if (!Number.isFinite(sampledAtMs)) return
      const index = Math.max(0, Math.min(
        TREND_WINDOW_COUNT - 1,
        Math.floor((sampledAtMs - options.startedAtMs) / windowDurationMs),
      ))
      let window = windows.get(index)
      if (!window) {
        window = {
          index,
          sampleCount: 0,
          firstSampledAt: sample.sampledAt,
          lastSampledAt: sample.sampledAt,
          totals: Object.fromEntries(metricNames.map((name) => [name, 0])),
        }
        windows.set(index, window)
      }
      window.sampleCount += 1
      window.lastSampledAt = sample.sampledAt
      for (const name of metricNames) window.totals[name] += sample[name]
    },
    assertHealthy() {
      if (!options.formal) return
      const report = buildSummary()
      if (report.windows.length < Math.floor(TREND_WINDOW_COUNT / 2)) {
        throw new Error(`formal sustained sampling covered too few trend windows: ${report.windows.length}`)
      }
      for (const [name, slope] of Object.entries(report.secondHalfSlopePerHour)) {
        if (slope > FORMAL_SLOPE_BUDGET_PER_HOUR[name]) {
          throw new Error(`formal sustained ${name} trend exceeds the hourly budget: ${safe({
            slope,
            budget: FORMAL_SLOPE_BUDGET_PER_HOUR[name],
            trend: report,
          })}`)
        }
      }
    },
    summary: buildSummary,
  }

  function buildSummary() {
    const selected = [...windows.values()].sort((left, right) => left.index - right.index)
    const summarized = selected.map((window) => ({
      index: window.index,
      offsetStartMs: window.index * windowDurationMs,
      offsetEndMs: Math.min(options.durationMs, (window.index + 1) * windowDurationMs),
      sampleCount: window.sampleCount,
      firstSampledAt: window.firstSampledAt,
      lastSampledAt: window.lastSampledAt,
      average: Object.fromEntries(metricNames.map((name) => [
        name,
        window.totals[name] / window.sampleCount,
      ])),
    }))
    const secondHalf = summarized.slice(Math.floor(summarized.length / 2))
    return {
      formal: options.formal,
      maxWindows: TREND_WINDOW_COUNT,
      windowDurationMs,
      windows: summarized,
      secondHalfSlopePerHour: Object.fromEntries(metricNames.map((name) => [
        name,
        linearSlopePerHour(secondHalf, name),
      ])),
      slopeBudgetPerHour: options.formal ? FORMAL_SLOPE_BUDGET_PER_HOUR : undefined,
    }
  }
}

function linearSlopePerHour(windows, metricName) {
  if (windows.length < 2) return 0
  const points = windows.map((window) => ({
    x: (window.offsetStartMs + window.offsetEndMs) / 2 / (60 * 60_000),
    y: window.average[metricName],
  }))
  const meanX = points.reduce((total, point) => total + point.x, 0) / points.length
  const meanY = points.reduce((total, point) => total + point.y, 0) / points.length
  const numerator = points.reduce((total, point) => total + ((point.x - meanX) * (point.y - meanY)), 0)
  const denominator = points.reduce((total, point) => total + ((point.x - meanX) ** 2), 0)
  return denominator > 0 ? numerator / denominator : 0
}

function boundedInteger(value, minimum, maximum, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

function safe(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
