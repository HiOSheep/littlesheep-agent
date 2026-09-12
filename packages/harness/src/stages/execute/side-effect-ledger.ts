// Runtime-owned side-effect ledger for resumable tool execution.
//
// The ledger is intentionally conservative. A read-only tool does not create
// a record. A write-capable or unknown tool is recorded before it starts and
// must reach a durable terminal record before a checkpoint can be resumed.

import { createHash } from 'node:crypto'
import type {
  AgentTool,
  ReconciliationValue,
  RunContext,
  SideEffectCheckpoint,
  ToolResourceAccess,
  ToolResult,
} from '@littlesheep/types'
import { boundReconciliationKey } from '@littlesheep/types'
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
  /** Tool-declared bounded recovery key; absent when the tool declares none. */
  reconciliationKey?: ReconciliationValue
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
  const reconciliationKey = toolReconciliationKey(tool, input)
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
    ...(reconciliationKey ? { reconciliationKey } : {}),
  }
}

/**
 * Ask the tool for its reconciliation key and keep only a bounded value. A
 * throwing or oversized projector counts as "no key", so recovery falls back
 * to the conservative unknown outcome instead of persisting anything the tool
 * did not intend to persist.
 */
function toolReconciliationKey(tool: AgentTool, input: unknown): ReconciliationValue | undefined {
  if (!tool.reconciliationKey) return undefined
  try {
    return boundReconciliationKey(tool.reconciliationKey(input))
  } catch {
    return undefined
  }
}

export async function beginSideEffect(ctx: RunContext, descriptor: SideEffectDescriptor): Promise<BeginSideEffectResult> {
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
  const lease = ctx.effectLeases
    ? await ctx.effectLeases.acquire(descriptor.idempotencyKey)
    : undefined
  if (lease?.kind === 'conflict') {
    return {
      kind: 'blocked',
      descriptor,
      reason: `side effect is owned by another worker${lease.leaseUntil ? ` until ${lease.leaseUntil}` : ''}`,
    }
  }
  // Lease acquisition is asynchronous and parallel tool branches may have
  // updated the ledger while this branch waited. Always merge into the latest
  // projection and re-check replay/capacity constraints after ownership.
  const effects = [...(ctx.sideEffects ?? [])]
  const concurrentlyStarted = effects.find((item) => item.idempotencyKey === descriptor.idempotencyKey)
  if (concurrentlyStarted) {
    await releaseEffectLease(ctx, descriptor)
    return concurrentlyStarted.status === 'succeeded'
      ? { kind: 'duplicate', descriptor, status: concurrentlyStarted.status }
      : {
          kind: 'blocked',
          descriptor,
          reason: `side effect ${descriptor.idempotencyKey} already has status ${concurrentlyStarted.status}`,
        }
  }
  if (effects.length >= MAX_SIDE_EFFECTS) {
    const terminal = effects.findIndex((item) => item.status === 'succeeded' || item.status === 'failed')
    if (terminal < 0) {
      await releaseEffectLease(ctx, descriptor)
      return { kind: 'blocked', descriptor, reason: 'side-effect ledger capacity is exhausted' }
    }
    effects.splice(terminal, 1)
  }
  const ownedEntry: SideEffectCheckpoint = {
    ...entry,
    ...(lease?.kind === 'acquired' ? { ownerId: lease.ownerId, leaseUntil: lease.leaseUntil } : {}),
  }
  effects.push(ownedEntry)
  replaceSideEffectEvidence(ctx, 'execute', effects)
  try {
    await ctx.appendDurableEvent?.({
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
        ...(descriptor.reconciliationKey ? { reconciliationKey: descriptor.reconciliationKey } : {}),
        ...(lease?.kind === 'acquired' ? { ownerId: lease.ownerId, leaseUntil: lease.leaseUntil } : {}),
        ...(descriptor.stepId ? { stepId: descriptor.stepId } : {}),
      },
    });
  } catch (error) {
    // The append may have committed before reporting an error. Keep the
    // in-memory projection conservative and let recovery reconcile the event
    // stream instead of attempting a second, potentially conflicting event.
    replaceSideEffectStatus(ctx, descriptor, 'unknown', `effect intent durability failed: ${errorMessage(error)}`);
    await releaseEffectLease(ctx, descriptor);
    throw error;
  }
  return { kind: 'started', descriptor }
}

export async function finishSideEffect(
  ctx: RunContext,
  descriptor: SideEffectDescriptor,
  result: ToolResult,
  durable = true,
  settlement: 'succeeded' | 'failed' | 'cancelled' | 'unknown' = result.ok ? 'succeeded' : 'unknown',
): Promise<void> {
  const effects = ctx.sideEffects ?? []
  const index = effects.findIndex((item) => item.idempotencyKey === descriptor.idempotencyKey)
  if (index < 0) return
  const current = effects[index]!
  let settlementLease: { ownerId: string; leaseUntil: string } | undefined
  if (ctx.effectLeases) {
    try {
      settlementLease = await ctx.effectLeases.confirm(descriptor.idempotencyKey)
    } catch (error) {
      replaceSideEffectStatus(ctx, descriptor, 'unknown', `effect ownership confirmation failed: ${errorMessage(error)}`)
      throw error
    }
  }
  const entry: SideEffectCheckpoint = {
    ...current,
    ...settlementLease,
    status: settlement,
    endedAt: new Date().toISOString(),
    evidenceRef: `tool:${descriptor.callId}`,
    ...(!result.ok && result.error ? { error: result.error.slice(0, 2_048) } : {}),
  }
  const updated = [...effects]
  updated[index] = entry
  replaceSideEffectEvidence(ctx, 'execute', updated)
  if (!durable) return
  try {
    await ctx.appendDurableEvent?.({
      type: 'effect_settled',
      source: 'tool',
      eventId: `${ctx.runId}:effect:${descriptor.idempotencyKey}:settled`,
      idempotencyKey: `${ctx.runId}:effect:${descriptor.idempotencyKey}:settled`,
      payload: {
        effectId: descriptor.idempotencyKey,
        status: settlement,
        evidenceRef: entry.evidenceRef,
        ...settlementLease,
        ...(entry.error ? { errorHash: hashText(entry.error), errorLength: entry.error.length } : {}),
      },
    });
    await releaseEffectLease(ctx, descriptor);
  } catch (error) {
    // A thrown append is ambiguous: the event may already be on disk. Do not
    // append a compensating `unknown` settlement; recovery must inspect the
    // authoritative event stream and settle only an actually pending intent.
    replaceSideEffectStatus(ctx, descriptor, 'unknown', `effect settlement durability failed: ${errorMessage(error)}`);
    throw error;
  }
}

export async function markSideEffectUnknown(ctx: RunContext, descriptor: SideEffectDescriptor, error: string): Promise<void> {
  replaceSideEffectStatus(ctx, descriptor, 'unknown', error)
  await ctx.appendDurableEvent?.({
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
  });
  await releaseEffectLease(ctx, descriptor);
}

async function releaseEffectLease(ctx: RunContext, descriptor: SideEffectDescriptor): Promise<void> {
  try {
    await ctx.effectLeases?.release(descriptor.idempotencyKey);
  } catch (error) {
    ctx.toolContext.log?.('error', 'effect lease release failed after durable lifecycle boundary', {
      effectId: descriptor.idempotencyKey,
      error: errorMessage(error),
    });
  }
}

function replaceSideEffectStatus(
  ctx: RunContext,
  descriptor: SideEffectDescriptor,
  status: SideEffectCheckpoint['status'],
  error?: string,
): void {
  const effects = ctx.sideEffects ?? [];
  const index = effects.findIndex((item) => item.idempotencyKey === descriptor.idempotencyKey);
  if (index < 0) return;
  const updated = [...effects];
  updated[index] = {
    ...effects[index]!,
    status,
    ...(error ? { error: error.slice(0, 2_048) } : {}),
  };
  replaceSideEffectEvidence(ctx, 'execute', updated);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
