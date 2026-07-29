// Renderer-side presentation and request helpers for active-run task events.
// Runtime remains authoritative for queueing, deduplication, and application.
import type {
  RuntimeEventIngressOutcome,
} from '@littlesheep/types'
import type {
  RuntimePatch,
  RuntimeState,
} from '../../shared/runtime-api-contracts'


export type RuntimeTaskEventSubject = 'message' | 'setting' | 'file'


export type RuntimeTaskEventNoticeTone = 'success' | 'neutral' | 'warning' | 'error'


export interface RuntimeTaskEventNotice {
  id: string
  tone: RuntimeTaskEventNoticeTone
  text: string
  createdAt: number
}


export interface RuntimeTaskEventIdentity {
  id: string
  dedupKey: string
}


export interface RuntimeSettingEventEntry {
  key: keyof RuntimePatch
  value: RuntimeState[keyof RuntimePatch]
}


const RUNTIME_PATCH_KEYS = [
  'model',
  'reasoning',
  'profile',
  'contextCompressionThresholdRatio',
  'workspace',
] as const satisfies readonly (keyof RuntimePatch)[]


export function createRuntimeTaskEventIdentity(prefix: string): RuntimeTaskEventIdentity {
  const randomPart = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const id = `${normalizeIdentityPrefix(prefix)}-${randomPart}`
  return { id, dedupKey: `app:${id}` }
}


export function runtimeSettingEventEntries(
  patch: RuntimePatch,
  state: RuntimeState,
): RuntimeSettingEventEntry[] {
  return RUNTIME_PATCH_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(patch, key))
    .map((key) => ({ key, value: state[key] }))
}


export function runtimeTaskEventWasQueued(outcome: RuntimeEventIngressOutcome): boolean {
  return outcome.kind === 'accepted' || outcome.kind === 'duplicate'
}


export function runtimeTaskEventNeedsNewIdentity(outcome: RuntimeEventIngressOutcome): boolean {
  if (outcome.kind === 'accepted' || outcome.kind === 'duplicate' || outcome.kind === 'expired') return true
  return outcome.kind === 'rejected' && outcome.reason === 'conflict'
}


export function describeRuntimeTaskEventOutcome(
  subject: RuntimeTaskEventSubject,
  outcome: RuntimeEventIngressOutcome,
  now = Date.now(),
): RuntimeTaskEventNotice {
  const noun = subjectLabel(subject)
  if (outcome.kind === 'accepted') {
    return notice('success', acceptedText(subject), now)
  }
  if (outcome.kind === 'duplicate') {
    return notice('neutral', `${noun}已在当前任务中，无需重复加入`, now)
  }
  if (outcome.kind === 'expired') {
    return notice('warning', `${noun}已过期，未加入当前任务`, now)
  }

  if (outcome.reason === 'conflict') {
    return notice('warning', `${noun}与已有更新冲突，未加入当前任务`, now)
  }
  if (outcome.reason === 'capacity' || outcome.reason === 'active-run-capacity') {
    return notice('warning', `当前任务的更新队列已满，${noun}未发送`, now)
  }
  if (outcome.reason === 'run-not-active' || outcome.reason === 'run-mismatch') {
    return notice('warning', `当前任务已经结束，${noun}未发送`, now)
  }
  return notice('error', `${noun}未加入当前任务：${boundedMessage(outcome.message)}`, now)
}


export function describeRuntimeTaskEventFailure(
  subject: RuntimeTaskEventSubject,
  error: unknown,
  now = Date.now(),
): RuntimeTaskEventNotice {
  return notice(
    'error',
    `${subjectLabel(subject)}未加入当前任务：${boundedMessage(error instanceof Error ? error.message : String(error))}`,
    now,
  )
}


export function describeRuntimeSettingBatch(
  outcomes: readonly RuntimeEventIngressOutcome[],
  failures: readonly unknown[],
  now = Date.now(),
): RuntimeTaskEventNotice {
  const queued = outcomes.filter(runtimeTaskEventWasQueued).length
  const total = outcomes.length + failures.length
  if (total > 0 && queued === total) {
    return notice('success', '设置已保存，当前任务会在安全边界重新校准', now)
  }
  if (queued > 0) {
    return notice('warning', `设置已保存，${queued}/${total} 项变化已加入当前任务`, now)
  }
  const firstFailure = failures[0]
  if (firstFailure !== undefined) {
    return notice(
      'warning',
      `设置已保存，但当前任务未接收变化：${boundedMessage(firstFailure instanceof Error ? firstFailure.message : String(firstFailure))}`,
      now,
    )
  }
  const firstOutcome = outcomes[0]
  if (firstOutcome) {
    const detail = describeRuntimeTaskEventOutcome('setting', firstOutcome, now)
    return { ...detail, tone: detail.tone === 'error' ? 'warning' : detail.tone }
  }
  return notice('neutral', '设置已保存', now)
}


export function runtimeEventNoticeDurationMs(tone: RuntimeTaskEventNoticeTone): number {
  return tone === 'success' || tone === 'neutral' ? 3_200 : 6_400
}


function acceptedText(subject: RuntimeTaskEventSubject): string {
  if (subject === 'message') return '已加入当前任务，将在安全边界处理'
  if (subject === 'setting') return '设置变化已加入当前任务，将在安全边界重新校准'
  return '文件已保存，当前任务会在安全边界读取变化'
}


function subjectLabel(subject: RuntimeTaskEventSubject): string {
  if (subject === 'message') return '这条补充'
  if (subject === 'setting') return '这项设置变化'
  return '这次文件变化'
}


function notice(
  tone: RuntimeTaskEventNoticeTone,
  text: string,
  createdAt: number,
): RuntimeTaskEventNotice {
  return {
    id: `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    tone,
    text,
    createdAt,
  }
}


function normalizeIdentityPrefix(prefix: string): string {
  const normalized = prefix.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return (normalized || 'runtime-event').slice(0, 48)
}


function boundedMessage(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim()
  if (!normalized) return '原因未知'
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 179)}…`
}
