import { timingSafeEqual } from 'node:crypto'
import { getProvider, parseModelRef, resolveProviderReasoningRequest, type Config } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes.js'
import {
  PROVIDER_CALIBRATION_CHECKS,
  runProviderCalibration,
  type ProviderCalibrationCheck,
} from '../provider-calibration.js'
import { HttpError, json, readJson, type LocalAppApiRequest } from './http.js'

const MAX_CALIBRATION_BODY_BYTES = 16 * 1024
const REASONING_LEVELS = ['auto', 'low', 'medium', 'high', 'ultra'] as const

export async function routeProviderCalibration(
  request: LocalAppApiRequest,
  input: {
    getRunner: () => AgentRunner
    getConfig: () => Config
    token?: string
  },
): Promise<boolean> {
  if (request.path !== LOCAL_APP_API_ROUTES.providerCalibration) return false
  if (request.method !== 'POST') {
    json(request.res, 405, { error: 'Method not allowed' })
    return true
  }
  if (!input.token) {
    json(request.res, 404, { error: 'Provider calibration is not enabled.' })
    return true
  }
  if (!isAuthorized(request.req.headers.authorization, input.token)) {
    json(request.res, 401, { error: 'Provider calibration authorization failed.' })
    return true
  }

  const body = await readJson(request.req, MAX_CALIBRATION_BODY_BYTES)
  const runner = input.getRunner()
  const active = parseModelRef(runner.model)
  const provider = optionalString(body.provider) ?? active.provider
  if (provider !== active.provider) {
    throw new HttpError(409, `Provider calibration uses the active runtime provider (${active.provider}).`)
  }
  const configuredProvider = getProvider(input.getConfig(), provider)
  if (!configuredProvider) throw new HttpError(400, `Provider ${provider} is not configured.`)

  const model = optionalString(body.model) ?? active.model
  const checks = parseChecks(body.checks)
  const reasoning = parseReasoning(body.reasoning)
  const timeoutSeconds = parseTimeoutSeconds(body.timeoutSeconds)
  const resolvedReasoning = resolveProviderReasoningRequest(provider, model, reasoning)
  const results = await runProviderCalibration({
    client: runner.infra.llm,
    provider,
    model,
    checks,
    requestOptions: {
      reasoning_effort: resolvedReasoning.reasoningEffort,
      thinking: resolvedReasoning.thinking
        ? {
            type: resolvedReasoning.thinking.type,
            clear_thinking: resolvedReasoning.thinking.clearThinking,
          }
        : undefined,
      timeoutMs: timeoutSeconds * 1_000,
    },
  })
  json(request.res, 200, {
    ok: results.every((result) => result.ok),
    provider,
    model,
    checks,
    results,
  })
  return true
}

function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const provided = Buffer.from(header.slice('Bearer '.length), 'utf8')
  const expected = Buffer.from(token, 'utf8')
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

function parseChecks(value: unknown): ProviderCalibrationCheck[] {
  if (value === undefined) return [...PROVIDER_CALIBRATION_CHECKS]
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, 'checks must be a non-empty array.')
  const checks: ProviderCalibrationCheck[] = []
  for (const check of value) {
    if (typeof check !== 'string' || !PROVIDER_CALIBRATION_CHECKS.includes(check as ProviderCalibrationCheck)) {
      throw new HttpError(400, `Unsupported provider calibration check: ${String(check)}`)
    }
    if (!checks.includes(check as ProviderCalibrationCheck)) checks.push(check as ProviderCalibrationCheck)
  }
  return checks
}

function parseReasoning(value: unknown): typeof REASONING_LEVELS[number] {
  if (value === undefined) return 'high'
  if (typeof value !== 'string' || !REASONING_LEVELS.includes(value as typeof REASONING_LEVELS[number])) {
    throw new HttpError(400, `Unsupported reasoning level: ${String(value)}`)
  }
  return value as typeof REASONING_LEVELS[number]
}

function parseTimeoutSeconds(value: unknown): number {
  if (value === undefined) return 45
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 5 || value > 300) {
    throw new HttpError(400, 'timeoutSeconds must be between 5 and 300.')
  }
  return Math.round(value)
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'Expected a non-empty string.')
  return value.trim()
}
