// Runtime-owned side-effect ledger for resumable tool execution.
//
// The ledger is intentionally conservative. A read-only tool does not create
// a record. A write-capable or unknown tool is recorded before it starts and
// must reach a durable terminal record before a checkpoint can be resumed.

import { createHash } from 'node:crypto'
import type {
  AgentTool,
  RunContext,
  SideEffectCheckpoint,
  ToolResourceAccess,
  ToolResult,
} from '@littlesheep/types'
import { replaceSideEffectEvidence } from '../../execution-evidence-state.js'

const MAX_SIDE_EFFECTS = 256
const MAX_RESOURCE_KEYS = 32
const READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'memory_tree',
  'memory_search',
  'memory_deep_search',
  'session_status',
  'use_skill',
  'inspect_attachment',
])

export interface SideEffectDescriptor {
  idempotencyKey: string
  inputHash: string
  toolName: string
  stepId?: string
  callId: string
  resourceKeys: string[]
  effectKind: SideEffectCheckpoint['effectKind']
}

export type BeginSideEffectResult =
  | { kind: 'none' }
  | { kind: 'started'; descriptor: SideEffectDescriptor }
  | { kind: 'duplicate'; descriptor: SideEffectDescriptor; status: SideEffectCheckpoint['status'] }
  | { kind: 'blocked'; descriptor: SideEffectDescriptor; reason: string }

export function describeSideEffect(
  tool: AgentTool,
  input: unknown,
  resources: readonly ToolResourceAccess[],
  stepId: string | undefined,
  callId: string,
): SideEffectDescriptor | undefined {
  const resourceKeys = resources
    .filter((resource) => resource.mode === 'write')
    .map((resource) => resource.key.trim())
    .filter(Boolean)
    .slice(0, MAX_RESOURCE_KEYS)
  const hasReadResources = resources.length > 0 && resources.every((resource) => resource.mode === 'read')
  if (resourceKeys.length === 0 && hasReadResources) return undefined
  if (resourceKeys.length === 0 && READ_ONLY_TOOLS.has(tool.name)) return undefined

  const inputHash = hashInput(input)
  const effectKind: SideEffectCheckpoint['effectKind'] = resourceKeys.length > 0
    ? 'local_mutation'
    : tool.name === 'exec'
      ? 'external'
      : 'unknown'
  return {
    idempotencyKey: `tool:${tool.name}:${inputHash}`,
    inputHash,
    toolName: tool.name,
    ...(stepId ? { stepId } : {}),
    callId,
    resourceKeys,
    effectKind,
  }
}

export function beginSideEffect(ctx: RunContext, descriptor: SideEffectDescriptor): BeginSideEffectResult {
  const existing = (ctx.sideEffects ?? []).find((item) => item.idempotencyKey === descriptor.idempotencyKey)
  if (existing) {
    if (existing.status === 'succeeded') {
      return { kind: 'duplicate', descriptor, status: existing.status }
    }
    return {
      kind: 'blocked',
      descriptor,
      reason: `side effect ${descriptor.idempotencyKey} already has status ${existing.status}`,
    }
  }
  const entry: SideEffectCheckpoint = {
    ...descriptor,
    status: 'in_progress',
    startedAt: new Date().toISOString(),
  }
  const effects = [...(ctx.sideEffects ?? [])]
  if (effects.length >= MAX_SIDE_EFFECTS) {
    const terminal = effects.findIndex((item) => item.status === 'succeeded' || item.status === 'failed')
    if (terminal < 0) return { kind: 'blocked', descriptor, reason: 'side-effect ledger capacity is exhausted' }
    effects.splice(terminal, 1)
  }
  effects.push(entry)
  replaceSideEffectEvidence(ctx, 'execute', effects)
  void ctx.appendDurableEvent?.({
    type: 'effect_intent_created',
    source: 'runtime',
    eventId: `${ctx.runId}:effect:${descriptor.idempotencyKey}:intent`,
    idempotencyKey: `${ctx.runId}:effect:${descriptor.idempotencyKey}:intent`,
    payload: {
      effectId: descriptor.idempotencyKey,
      idempotencyKey: descriptor.idempotencyKey,
      toolName: descriptor.toolName,
      inputHash: descriptor.inputHash,
      effectKind: descriptor.effectKind,
      ...(descriptor.stepId ? { stepId: descriptor.stepId } : {}),
    },
  }).catch(() => undefined);
  return { kind: 'started', descriptor }
}

export function finishSideEffect(
  ctx: RunContext,
  descriptor: SideEffectDescriptor,
  result: ToolResult,
  durable = true,
): void {
  const effects = ctx.sideEffects ?? []
  const index = effects.findIndex((item) => item.idempotencyKey === descriptor.idempotencyKey)
  if (index < 0) return
  const current = effects[index]!
  const entry: SideEffectCheckpoint = {
    ...current,
    status: result.ok ? 'succeeded' : 'unknown',
    endedAt: new Date().toISOString(),
    evidenceRef: `tool:${descriptor.callId}`,
    ...(!result.ok && result.error ? { error: result.error.slice(0, 2_048) } : {}),
  }
  const updated = [...effects]
  updated[index] = entry
  replaceSideEffectEvidence(ctx, 'execute', updated)
  if (!durable) return
  void ctx.appendDurableEvent?.({
    type: 'effect_settled',
    source: 'tool',
    eventId: `${ctx.runId}:effect:${descriptor.idempotencyKey}:settled`,
    idempotencyKey: `${ctx.runId}:effect:${descriptor.idempotencyKey}:settled`,
    payload: {
      effectId: descriptor.idempotencyKey,
      status: result.ok ? 'succeeded' : 'unknown',
      evidenceRef: entry.evidenceRef,
      ...(entry.error ? { errorHash: hashText(entry.error), errorLength: entry.error.length } : {}),
    },
  }).catch(() => undefined);
}

export function markSideEffectUnknown(ctx: RunContext, descriptor: SideEffectDescriptor, error: string): void {
  const effects = ctx.sideEffects ?? []
  const index = effects.findIndex((item) => item.idempotencyKey === descriptor.idempotencyKey)
  if (index < 0) return
  const updated = [...effects]
  updated[index] = { ...effects[index]!, status: 'unknown', error: error.slice(0, 2_048) }
  replaceSideEffectEvidence(ctx, 'execute', updated)
  void ctx.appendDurableEvent?.({
    type: 'effect_settled',
    source: 'runtime',
    eventId: `${ctx.runId}:effect:${descriptor.idempotencyKey}:unknown`,
    idempotencyKey: `${ctx.runId}:effect:${descriptor.idempotencyKey}:unknown`,
    payload: {
      effectId: descriptor.idempotencyKey,
      status: 'unknown',
      errorHash: hashText(error),
      errorLength: error.length,
    },
  }).catch(() => undefined);
}

export function sideEffectCheckpointReason(descriptor: SideEffectDescriptor, phase: 'started' | 'finished'): string {
  return `${phase} effectful tool ${descriptor.toolName} (${descriptor.idempotencyKey})`
}

function hashInput(input: unknown): string {
  return createHash('sha256').update(stableSerialize(input), 'utf8').digest('hex')
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
