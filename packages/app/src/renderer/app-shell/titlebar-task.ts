// The titlebar's task pill state, kept out of the controller's composition surface.
//
// The controller owns the session list, the transcript and the chat clock; this module turns them
// into the one value the pill renders, so the pill can never read a different conversation than the
// transcript beside it and the controller does not grow for a presentation concern.
import { useMemo } from 'react'
import type { SessionMeta } from '../api'
import type { ChatMessage } from '../chat/types'
import type { TitlebarTask } from '../sidebar/running-pill'
import type { HistoryActivity } from '../../shared/history-activity'

/** The newest run activity in the transcript, or null while nothing has run yet. */
export function latestRunActivity(messages: ChatMessage[]): HistoryActivity | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const activity = messages[index]?.activity
    if (activity) return activity
  }
  return null
}

export function useTitlebarTask({
  sessions,
  currentSession,
  messages,
  activityNow,
}: {
  sessions: SessionMeta[]
  currentSession: string | null | undefined
  messages: ChatMessage[]
  activityNow: number
}): TitlebarTask {
  const activity = latestRunActivity(messages)
  return useMemo(() => ({
    title: sessions.find((session) => session.id === currentSession)?.title?.trim() ?? '',
    // A conversation that has not been named yet still has a run worth reporting, so the pill keys
    // off the session existing rather than off its title.
    hasSession: Boolean(currentSession),
    activity,
    now: activityNow,
  }), [activity, activityNow, currentSession, sessions])
}
