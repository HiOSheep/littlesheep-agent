import { shortActivityText } from './task-progress-indicator'
import { toolActionLabel, toolSummaryText } from './agent-tool-row'
import type { AssistantTurnActivity } from './types'
import { Markdown } from '../Markdown'

/** A bounded projection of recorded activity; full output stays in the disclosure. */
export function liveActivityLabel(activity: AssistantTurnActivity): string {
  const tool = activity.tools.find((entry) => entry.startedAt !== undefined && entry.endedAt === undefined)
  if (tool) return `${toolActionLabel(tool.name)} · ${shortActivityText(toolSummaryText(tool) || tool.name, 100)}`
  const step = activity.steps.find((entry) => entry.status === 'running')
  if (step) return step.title
  const preparing = activity.transcript?.slice().reverse().find((entry) => entry.kind === 'preparing' && entry.status === 'running')
  if (preparing?.kind === 'preparing') return preparing.name ? `准备调用 · ${preparing.name}` : '准备工具调用'
  return activity.reasoning?.some((entry) => entry.status === 'running') ? '正在思考' : '正在处理'
}

export function TurnLiveStatus({ activity, responseText = '' }: { activity: AssistantTurnActivity; responseText?: string }) {
  if (activity.status !== 'running') return null
  const failures = activity.tools.filter((tool) => tool.ok === false || tool.error)
  const update = activity.transcript?.slice().reverse().find((entry) => entry.kind === 'text' && entry.text.trim())
  return <div className="turn-live-status">
    <div className="turn-live-current" role="status"><span className="turn-live-dot" aria-hidden="true" /><span>{liveActivityLabel(activity)}</span></div>
    {failures.length > 0 && <div className="turn-live-warning" role="status">已记录 {failures.length} 次调用失败，可展开过程查看原因</div>}
    {update?.kind === 'text' && update.text.trim() !== responseText.trim() && <div className="turn-live-update"><Markdown text={update.text} /></div>}
  </div>
}
