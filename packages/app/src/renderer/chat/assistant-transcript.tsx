// Ordered conversation prose, thinking, and execution rows; no Runtime authority.
import { useState } from 'react'
import { Markdown } from '../Markdown'
import { ActivityGlyph } from './activity-glyph'
import { ReasoningRow } from './reasoning-row'
import { AgentToolRow, PreparingLineDeltaBadge, toolActionLabel } from './agent-tool-row'
import { DisclosurePanel } from './disclosure-panel'
import { compactTranscriptEntries } from './activity-visibility'
import type { AssistantTurnActivity, TranscriptEntry } from './types'

/**
 * Model transcript: thinking, tool rows, and per-turn prose in the exact order
 * the model produced them. The single durable driver owns these entries; a run
 * without a transcript falls back to the activity-step layout.
 */
export function AssistantTranscript({
  transcript,
  activity,
  now,
  onOpenFile,
  compact = false,
  showStatus = true,
}: {
  transcript: TranscriptEntry[]
  activity: AssistantTurnActivity
  now: number
  onOpenFile: (path: string) => void
  compact?: boolean
  showStatus?: boolean
}) {
  const tools = new Map(activity.tools.map((tool) => [tool.callId, tool]))
  // Compact mode folds the finished process away, never the facts that need a
  // decision or a fix: failed/denied rows stay readable (UX-16), and the activity-level
  // facts that outlive the fold are rendered by `ActivityAttentionRow` outside this body.
  const rows = compact ? compactTranscriptEntries(transcript, activity.tools) : transcript
  return (
    <div className="assistant-activity-flow assistant-transcript" role="group" aria-label="Agent 工作过程">
      {rows.map((entry) => {
        if (entry.kind === 'system') {
          return <SystemPromptRow key={entry.id} id={entry.id} text={entry.text} />
        }
        if (entry.kind === 'reasoning') {
          return <ReasoningRow key={entry.id} id={entry.id} text={entry.text} status={entry.status} />
        }

        if (entry.kind === 'text') {
          return (
            <div key={entry.id} className="agent-transcript-prose" data-transcript-entry={entry.id} data-stream-state={activity.status === 'running' ? 'streaming' : 'settled'}>
              <Markdown text={entry.text} streaming={entry.status === 'running'} />
              {(entry.status === 'aborted' || entry.status === 'failed') && (
                <span className="agent-transcript-partial">{entry.status === 'aborted' ? '此段生成已中止' : '此段生成未完成'}</span>
              )}
            </div>
          )
        }
        if (entry.kind === 'preparing') {
          return <PreparingRow key={entry.id} entry={entry} />
        }
        const tool = tools.get(entry.callId)
        return tool
          ? <AgentToolRow key={entry.id} tool={tool} now={now} onOpenFile={onOpenFile} />
          : null
      })}
      {!compact && showStatus && <ActiveActivityStatus activity={activity} />}
    </div>
  )
}

/** Prose stays in the conversation; only consecutive execution rows can fold. */
export function ConversationTimeline(props: {
  transcript: TranscriptEntry[]; activity: AssistantTurnActivity; now: number; onOpenFile: (path: string) => void
}) {
  const groups: TranscriptEntry[][] = []
  for (const entry of props.transcript) {
    const previous = groups.at(-1)
    if (previous && entry.kind !== 'text' && previous[0]?.kind !== 'text') previous.push(entry)
    else groups.push([entry])
  }
  return <div className="assistant-conversation-timeline">
    {groups.map((entries) => entries[0]?.kind === 'text'
      ? <AssistantTranscript key={entries[0].id} {...props} transcript={entries} compact={false} showStatus={false} />
      : <ExecutionRows key={entries[0]?.id} {...props} transcript={entries} />)}
    <ActiveActivityStatus activity={props.activity} />
  </div>
}

function ExecutionRows(props: {
  transcript: TranscriptEntry[]; activity: AssistantTurnActivity; now: number; onOpenFile: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const toolById = new Map(props.activity.tools.map((tool) => [tool.callId, tool]))
  const foldable = props.transcript.filter((entry) => entry.kind === 'tool' && toolById.get(entry.callId)?.ok === true)
  const hidden = new Set(foldable.length > 3 && !expanded ? foldable.slice(0, -2).map((entry) => entry.id) : [])
  return <div className="assistant-execution-group">
    {hidden.size > 0 && <button type="button" className="assistant-execution-toggle" aria-expanded={expanded} onClick={() => setExpanded(true)}>
      展开 {hidden.size} 次已完成的调用
    </button>}
    <AssistantTranscript {...props} transcript={props.transcript.filter((entry) => !hidden.has(entry.id))} showStatus={false} />
    {expanded && foldable.length > 3 && <button type="button" className="assistant-execution-toggle" aria-expanded={expanded} onClick={() => setExpanded(false)}>收起已完成的调用</button>}
  </div>
}

/**
 * The system prompt the run was actually started with. It is reference material
 * and stays folded behind its own row — but folding it has to be the same smooth
 * disclosure as every other row, not an instant snap.
 */
function SystemPromptRow({ id, text }: { id: string; text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="agent-transcript-reasoning system" data-transcript-entry={id}>
      <button type="button" className="agent-flow-row" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="agent-flow-glyph agent-reasoning-glyph" aria-hidden="true"><ActivityGlyph kind="system" /></span>
        <span className="agent-flow-title">系统提示词</span>
        <span className="agent-flow-separator" aria-hidden="true" />
        <span className="agent-flow-summary">本轮实际提示词</span>
        <span className={`agent-flow-chevron${open ? ' open' : ''}`} aria-hidden="true" />
      </button>
      <DisclosurePanel open={open}>
        <div className="agent-transcript-details">
          <Markdown text={text} />
        </div>
      </DisclosurePanel>
    </div>
  )
}

/**
 * A tool call whose arguments were still streaming. It becomes a real tool row
 * once `tool_start` arrives; until then it expands on the same disclosure
 * primitive, so the two rows read as one continuous gesture.
 */
function PreparingRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'preparing' }> }) {
  const [open, setOpen] = useState(false)
  const action = entry.name ? toolActionLabel(entry.name) : '调用工具'
  const status = entry.status === 'running' ? '正在生成参数'
    : entry.status === 'done' ? '等待执行'
      : entry.status === 'aborted' ? '已中止' : '生成失败'
  return (
    <div className={`agent-tool-preparing ${entry.status}`} data-transcript-entry={entry.id}>
      <button type="button" className={`agent-flow-row${entry.status === 'running' ? ' is-active' : ''}`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="agent-flow-glyph" aria-hidden="true"><ActivityGlyph kind="pending" /></span>
        <span className="agent-flow-title">准备{action === '调用' ? entry.name : action}</span>
        <span className="agent-flow-separator" aria-hidden="true" />
        <span className="agent-flow-summary">{entry.argumentSummary ? `${entry.argumentSummary} · ${status}` : status}</span>
        <PreparingLineDeltaBadge progress={entry.lineProgress} />
        <span className={`agent-flow-chevron${open ? ' open' : ''}`} aria-hidden="true" />
      </button>
      <DisclosurePanel open={open}>
        <div className="agent-flow-details">
          <div>{status}{entry.name ? ` · 工具：${entry.name}` : ''}</div>
          {entry.argumentSummary && <div>目标：{entry.argumentSummary}</div>}
          <div>已接收 {entry.receivedCharacters} 个参数字符。实际执行结果见后续工具记录。</div>
        </div>
      </DisclosurePanel>
    </div>
  )
}

function ActiveActivityStatus({ activity }: { activity: AssistantTurnActivity }) {
  if (activity.status !== 'running') return null
  const current = [...(activity.reasoning ?? [])].reverse().find((item) => item.status === 'running' && item.source)
  if (!current) return null
  return (
    <div className="agent-flow-row agent-active-stage-row" role="status" aria-live="polite">
      <span className="agent-flow-glyph agent-active-stage-glyph" aria-hidden="true"><ActivityGlyph kind="reasoning" /></span>
      <span className="agent-flow-title">{current.source === 'model' ? '模型' : '运行时'}</span>
      <span className="agent-flow-separator" aria-hidden="true" />
      <span className="agent-flow-summary">{current.summary}</span>
    </div>
  )
}

