// The facts of a settled turn that no fold may hide (O1).
//
// The process body is one disclosure panel: compact display folds its unattended rows away,
// and a reader can fold it away in normal display too. Anything that has to stay readable
// while it is folded therefore cannot live inside that panel — it is rendered here, as the
// turn's own status row between the process trigger and the collapsible body, and it is the
// single home of those facts in both display modes.
import { activityAttentionLine, classifyCallFailures } from './activity-visibility'
import type { AssistantTurnActivity } from './types'


export function ActivityAttentionRow({ activity }: { activity: AssistantTurnActivity }) {
  // A running turn keeps its process open in both modes, and its live status row already says
  // what is happening; a verdict or a step count read mid-run would judge unfinished work.
  if (activity.status === 'running') return null
  const line = activityAttentionLine(activity)
  if (!line) return null
  return (
    <div
      className="agent-transcript-summary agent-transcript-attention"
      data-transcript-attention="true"
      data-tone={activity.status === 'failed' || classifyCallFailures(activity.tools).some((failure) => !failure.recovered) ? 'danger' : 'warning'}
      role="status"
    >
      {line}
    </div>
  )
}
