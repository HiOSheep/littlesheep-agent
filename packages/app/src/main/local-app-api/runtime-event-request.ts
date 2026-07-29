// Bounded validation for task-changing events submitted by the Renderer.

import type { AgentRunner } from '@littlesheep/runner'

export const MAX_RUNTIME_EVENT_REASON_LENGTH = 1_024
const MAX_RUNTIME_EVENT_ID_LENGTH = 256
const MAX_RUNTIME_EVENT_DEDUP_KEY_LENGTH = 512
const MAX_RUNTIME_EVENT_PAYLOAD_KEYS = 64
const MAX_RUNTIME_EVENT_TEXT_LENGTH = 16 * 1024
const MAX_RUNTIME_EVENT_PATH_LENGTH = 4_096

export type RuntimeEventInput = Parameters<AgentRunner['runtimeEvents']['append']>[1]

export function parseRuntimeTaskEventBody(
  body: Record<string, unknown>,
): { ok: true; input: RuntimeEventInput } | { ok: false; error: string } {
  if (!isRecord(body.payload)) {
    if (body.payload !== undefined) return { ok: false, error: 'runtime task event payload must be a JSON object' }
  }
  const payload: Record<string, unknown> = isRecord(body.payload) ? { ...body.payload } : {}
  const type = body.type as RuntimeEventInput['type']

  if (body.text !== undefined) {
    if (typeof body.text !== 'string' || body.text.trim().length === 0 || body.text.length > MAX_RUNTIME_EVENT_TEXT_LENGTH) {
      return { ok: false, error: `runtime user message text must be a non-empty string under ${MAX_RUNTIME_EVENT_TEXT_LENGTH} characters` }
    }
    if (payload.text !== undefined && payload.text !== body.text) {
      return { ok: false, error: 'runtime user message text is duplicated with different values' }
    }
    payload.text = body.text
  }

  if (body.reason !== undefined) {
    if (typeof body.reason !== 'string' || body.reason.length > MAX_RUNTIME_EVENT_REASON_LENGTH) {
      return { ok: false, error: 'runtime event reason must be a bounded string' }
    }
    if (body.reason.trim() && payload.reason === undefined) payload.reason = body.reason.trim()
  }

  const patchKeys = ['taskBookPatch', 'patch'] as const
  const suppliedPatchKeys = patchKeys.filter((key) => body[key] !== undefined)
  if (suppliedPatchKeys.length > 1) {
    return { ok: false, error: 'runtime task event may contain only one of taskBookPatch or patch' }
  }
  if (suppliedPatchKeys.length === 1) {
    const key = suppliedPatchKeys[0]!
    if (!isRecord(body[key]) || payload[key] !== undefined) {
      return { ok: false, error: `${key} must be an object and must not be duplicated in payload` }
    }
    payload[key] = body[key]
  }

  if (type === 'user_message') {
    if (typeof payload.text !== 'string' || payload.text.trim().length === 0 || payload.text.length > MAX_RUNTIME_EVENT_TEXT_LENGTH) {
      return { ok: false, error: 'user_message requires a bounded non-empty payload.text' }
    }
  } else if (type === 'setting_changed') {
    if (typeof payload.key !== 'string' || payload.key.trim().length === 0 || payload.key.length > 512) {
      return { ok: false, error: 'setting_changed requires a bounded payload.key' }
    }
  } else if (type === 'workspace_file_saved') {
    if (typeof payload.path !== 'string' || payload.path.trim().length === 0 || payload.path.length > MAX_RUNTIME_EVENT_PATH_LENGTH) {
      return { ok: false, error: 'workspace_file_saved requires a bounded payload.path' }
    }
  }

  if (Object.keys(payload).length > MAX_RUNTIME_EVENT_PAYLOAD_KEYS) {
    return { ok: false, error: `runtime task event payload cannot contain more than ${MAX_RUNTIME_EVENT_PAYLOAD_KEYS} keys` }
  }

  const metadata = parseRuntimeEventMetadata(body)
  if (!metadata.ok) return metadata
  return {
    ok: true,
    input: {
      type,
      source: 'app',
      payload,
      ...metadata.value,
    },
  }
}

function parseRuntimeEventMetadata(
  body: Record<string, unknown>,
): { ok: true; value: Partial<RuntimeEventInput> } | { ok: false; error: string } {
  const value: Partial<RuntimeEventInput> = {}
  for (const [key, maximum] of [
    ['id', MAX_RUNTIME_EVENT_ID_LENGTH],
    ['dedupKey', MAX_RUNTIME_EVENT_DEDUP_KEY_LENGTH],
    ['receivedAt', 128],
    ['expiresAt', 128],
  ] as const) {
    const raw = body[key]
    if (raw === undefined) continue
    if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > maximum) {
      return { ok: false, error: `runtime event ${key} must be a bounded non-empty string` }
    }
    value[key] = raw.trim() as never
  }
  return { ok: true, value }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
