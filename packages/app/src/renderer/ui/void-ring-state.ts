import type { HistoryActivity } from '../../shared/history-activity'

export type VoidRingState = 'idle' | 'loading' | 'thinking' | 'static'

/** Presentation only: the Runtime activity remains the source of truth. */
export function voidRingStateForActivity(activity: HistoryActivity | null): VoidRingState {
  if (!activity || activity.status === 'done') return 'idle'
  if (activity.status !== 'running') return 'static'
  if (activity.tools.some(tool => tool.startedAt !== undefined && tool.endedAt === undefined)) return 'loading'
  if (activity.transcript?.some(entry => entry.kind === 'reasoning' && entry.status === 'running')) return 'thinking'
  return 'loading'
}
