// Cross-day Provider usage statistics routes (O5).
//
// The series is served from the persisted projection; nothing here sums usage
// per request, so a caller never has to recompute totals. Reads are bounded by
// an explicit day-range cap and identity-facet cap, the timezone is an explicit
// part of both the request and the response, and coverage (missing usage,
// unreadable runs, backfill progress, clear cutoff, retention) travels with the
// numbers instead of being left for the UI to infer.
import {
  PROVIDER_USAGE_DAILY_DEFAULT_RANGE_DAYS,
  PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS,
  type ProviderUsageDailySeries,
} from '@littlesheep/types'
import {
  ProviderUsageDailyRangeError,
  ProviderUsageDailyService,
  assertBoundedDailyRange,
  defaultDailyRange,
  isSupportedTimeZone,
  isValidLocalDate,
  systemTimeZone,
  type AgentRunner,
} from '@littlesheep/runner'
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes.js'
import type { ArchiveIndex } from '../archive-index.js'
import type { SessionIndex } from '../session-index.js'
import { HttpError, json, readJson, resolveRunner, type LocalAppApiRequest } from './http.js'

/** Filter values are identities, not documents. */
const MAX_IDENTITY_FILTER_LENGTH = 128
const MAX_CACHED_DATA_ROOTS = 4

export interface UsageRouteContext {
  getRunner: () => AgentRunner | undefined
  dataDir: string
  sessionIndex: SessionIndex
  archiveIndex: ArchiveIndex
}

const services = new Map<string, ProviderUsageDailyService>()

export async function routeUsage(
  request: LocalAppApiRequest,
  context: UsageRouteContext,
): Promise<boolean> {
  const { path, method } = request
  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.usageDaily) {
    await respondDailySeries(request, context)
    return true
  }
  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.usageRefresh) {
    const body = await readJson(request.req)
    const budget = readBudget(body.budget)
    json(request.res, 200, {
      progress: await usageService(context).runPass({
        ...(budget === undefined ? {} : { budget }),
        ...(body.restart === true ? { restart: true } : {}),
      }),
    })
    return true
  }
  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.usageBackfill) {
    const body = await readJson(request.req)
    const action = body.action === undefined ? 'start' : body.action
    if (action !== 'start' && action !== 'cancel' && action !== 'status') {
      throw new HttpError(400, 'action must be start, cancel or status')
    }
    const service = usageService(context)
    const budgetPerStep = readBudget(body.budgetPerStep)
    const progress = action === 'start'
      ? await service.startBackfill({ ...(budgetPerStep === undefined ? {} : { budgetPerStep }) })
      : action === 'cancel' ? await service.cancelBackfill() : await service.progress()
    json(request.res, 200, { progress })
    return true
  }
  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.usageClear) {
    const body = await readJson(request.req)
    const through = typeof body.through === 'string' && body.through.trim()
      ? body.through.trim()
      : new Date().toISOString()
    const instant = Date.parse(through)
    if (!Number.isFinite(instant)) throw new HttpError(400, 'through must be an ISO-8601 instant')
    const clearedThrough = new Date(instant).toISOString()
    await usageService(context).clearThrough(clearedThrough)
    json(request.res, 200, { clearedThrough, clearedAt: new Date().toISOString() })
    return true
  }
  return false
}

async function respondDailySeries(
  request: LocalAppApiRequest,
  context: UsageRouteContext,
): Promise<void> {
  const { url, res } = request
  const requestedTimezone = url.searchParams.get('timezone')?.trim() ?? ''
  const timezone = requestedTimezone || systemTimeZone()
  if (!isSupportedTimeZone(timezone)) throw new HttpError(400, `unknown timezone: ${timezone}`)

  const from = url.searchParams.get('from')?.trim() ?? ''
  const to = url.searchParams.get('to')?.trim() ?? ''
  if (Boolean(from) !== Boolean(to)) throw new HttpError(400, 'from and to must be given together')
  const range = from && to
    ? { from, to }
    : defaultDailyRange(timezone, new Date(), PROVIDER_USAGE_DAILY_DEFAULT_RANGE_DAYS)
  if (!isValidLocalDate(range.from)) throw new HttpError(400, 'from must be YYYY-MM-DD')
  if (!isValidLocalDate(range.to)) throw new HttpError(400, 'to must be YYYY-MM-DD')
  if (range.from > range.to) throw new HttpError(400, 'from must not be after to')
  assertWithinDayBound(range.from, range.to)

  const provider = identityFilter(url.searchParams.get('provider'), 'provider')
  const model = identityFilter(url.searchParams.get('model'), 'model')
  const service = usageService(context)
  await service.synchronizeCurrent()
  const series: ProviderUsageDailySeries = service.query({
    from: range.from,
    to: range.to,
    timezone,
    timezoneSource: requestedTimezone ? 'request' : 'system',
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    knownSessionIds: await knownSessionIds(context),
  })
  json(res, 200, series)
}

function assertWithinDayBound(from: string, to: string): void {
  try {
    assertBoundedDailyRange(from, to)
  } catch (error) {
    if (error instanceof ProviderUsageDailyRangeError) {
      throw new HttpError(400, `${error.message} (max ${PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS} days)`)
    }
    throw error
  }
}

/**
 * Sessions that still exist anywhere (active or archived). A usage row whose
 * session is in neither list is a retained summary of a permanently deleted
 * conversation: the summary has no content, and permanent deletion never
 * rewrites consumption history.
 */
async function knownSessionIds(context: UsageRouteContext): Promise<ReadonlySet<string> | undefined> {
  try {
    const [active, archive] = await Promise.all([
      context.sessionIndex.list(),
      context.archiveIndex.list(),
    ])
    const ids = new Set<string>()
    for (const session of active) ids.add(session.id)
    for (const session of archive.sessions) ids.add(session.id)
    return ids
  } catch {
    // Retention is a soft coverage fact; an unreadable index must not turn the
    // usage response into an error, and must not claim rows were deleted.
    return undefined
  }
}

function identityFilter(value: string | null, label: string): string | undefined {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return undefined
  if (trimmed.length > MAX_IDENTITY_FILTER_LENGTH) {
    throw new HttpError(400, `${label} filter exceeds ${MAX_IDENTITY_FILTER_LENGTH} characters`)
  }
  return trimmed
}

function readBudget(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new HttpError(400, 'budget must be a positive number')
  }
  return Math.floor(value)
}

function usageService(context: UsageRouteContext): ProviderUsageDailyService {
  const existing = services.get(context.dataDir)
  if (existing) return existing
  const service = new ProviderUsageDailyService({
    dataRoot: context.dataDir,
    eventSource: {
      listRunPartitions: () => resolveRunner(context.getRunner).infra.durableEventStore.listRunPartitions(),
      listChangedRunPartitions: () => context.getRunner()?.infra.durableEventStore.listChangedRunPartitions() ?? Promise.resolve([]),
      acknowledgeUsagePartition: (partition, revision) => resolveRunner(context.getRunner).infra.durableEventStore.acknowledgeUsagePartition(partition, revision),
      readRunRevision: (partitionKey) => resolveRunner(context.getRunner).infra.durableEventStore.readRunRevision(partitionKey),
      read: (sessionId, runId) => resolveRunner(context.getRunner).infra.durableEventStore.read(sessionId, runId),
    },
    log: (level, message) => {
      if (level === 'info') console.log(`[usage] ${message}`)
      else if (level === 'warn') console.warn(`[usage] ${message}`)
      else console.error(`[usage] ${message}`)
    },
  })
  if (services.size >= MAX_CACHED_DATA_ROOTS) {
    const oldest = services.keys().next().value
    if (oldest !== undefined) services.delete(oldest)
  }
  services.set(context.dataDir, service)
  return service
}
