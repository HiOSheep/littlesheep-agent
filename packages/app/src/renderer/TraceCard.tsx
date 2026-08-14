import { useState } from 'react'
import { AgentToolRow } from './chat/agent-tool-row'
import type { LiveToolEvent } from './chat/types'

interface StageEntry { name: string; ok: boolean }
interface ToolEntry { name: string; input: unknown; output?: unknown; error?: string; ok: boolean }

interface TraceCardProps {
  trace?: StageEntry[]
  toolCalls?: ToolEntry[]
  durationMs?: number
  onOpenFile?: (path: string) => void
}

const STAGE_LABELS: Record<string, string> = {
  enter: '入口',
  classify: '分类',
  decide: '决策',
  execute: '执行',
  recover: '纠错',
  verify: '验证',
  evolve: '进化',
  capture: '捕获',
  reply: '回复',
  ask_user: '反问',
  finalize: '收尾',
}

export function TraceCard({ trace, toolCalls, durationMs, onOpenFile }: TraceCardProps) {
  const [open, setOpen] = useState(false)
  if (!trace && !toolCalls) return null
  const toolCount = toolCalls?.length ?? 0

  return (
    <div className="trace-card">
      <button type="button" className="trace-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>历史执行过程</span>
        <small>{toolCount > 0 ? `${toolCount} 个工具` : '无工具调用'} · {durationMs ? `${(durationMs / 1000).toFixed(1)}s` : '-'}</small>
        <i className="trace-chevron" aria-hidden="true" />
      </button>
      <div
        className={`trace-body disclosure-panel ${open ? 'open' : ''}`}
        aria-hidden={!open}
        {...(!open ? { inert: '' } : {})}
      >
        <div className="trace-body-inner">
          {trace && trace.length > 0 && (
            <div className="trace-stages">
              {trace.map((s, i) => (
                <span key={i} className={`trace-stage ${s.ok ? 'pass' : 'fail'}`}>
                  {STAGE_LABELS[s.name] ?? s.name}
                </span>
              ))}
            </div>
          )}
          {toolCalls && toolCalls.length > 0 && (
            <div className="trace-tools agent-tool-list">
              {toolCalls.map((t, i) => (
                <AgentToolRow key={i} tool={historyToolEvent(t, i)} now={0} onOpenFile={onOpenFile} />
              ))}
            </div>
          )}
          {!trace?.length && !toolCalls?.length && (
            <div className="trace-empty">本次没有工具调用。</div>
          )}
        </div>
      </div>
    </div>
  )
}

function historyToolEvent(tool: ToolEntry, index: number): LiveToolEvent {
  return {
    callId: `history-tool-${index}`,
    name: tool.name,
    input: tool.input,
    output: stringifyActivityValue(tool.output),
    error: tool.error,
    ok: tool.ok,
  }
}


function stringifyActivityValue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
