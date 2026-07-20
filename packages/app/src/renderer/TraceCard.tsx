import { useState } from 'react'

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
            <div className="trace-tools">
              {toolCalls.map((t, i) => (
                <TraceToolItem key={i} tool={t} onOpenFile={onOpenFile} />
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

function TraceToolItem({
  tool,
  onOpenFile,
}: {
  tool: ToolEntry
  onOpenFile?: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const targetPath = legacyToolFilePath(tool.input)

  return (
    <section className={`trace-tool activity-command ${tool.ok ? 'pass' : 'fail'} ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="activity-command-header"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="activity-command-icon" aria-hidden="true" />
        <span className="activity-command-label">{tool.ok ? '已运行' : '运行失败'} {tool.name}</span>
        <span className="activity-command-duration">历史</span>
        <span className="activity-command-chevron" aria-hidden="true" />
      </button>
      <div
        className={`activity-command-body disclosure-panel ${open ? 'open' : ''}`}
        aria-hidden={!open}
        {...(!open ? { inert: '' } : {})}
      >
        <div className="activity-command-shell">
          <div className="activity-command-shell-title">
            <span>{tool.name}</span>
            {targetPath && onOpenFile && (
              <button
                type="button"
                className="activity-command-file-action"
                onClick={() => onOpenFile(targetPath)}
              >
                <span>打开文件</span>
              </button>
            )}
          </div>
          <div className="trace-tool-label">输入</div>
          <pre>{fmt(tool.input)}</pre>
          {tool.output !== undefined && (
            <>
              <div className="trace-tool-label">输出</div>
              <pre>{fmt(tool.output)}</pre>
            </>
          )}
          {tool.error && (
            <>
              <div className="trace-tool-label">错误</div>
              <pre className="error">{tool.error}</pre>
            </>
          )}
          <div className={`activity-command-shell-status ${tool.ok ? 'pass' : 'fail'}`}>
            {tool.ok ? '成功' : '失败'}
          </div>
        </div>
      </div>
    </section>
  )
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return v.length > 600 ? `${v.slice(0, 600)}...` : v
  return JSON.stringify(v, null, 2).slice(0, 600)
}

function legacyToolFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  for (const key of ['path', 'filePath', 'target', 'targetPath']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return null
}
