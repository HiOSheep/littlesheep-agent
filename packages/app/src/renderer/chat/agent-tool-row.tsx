import { useState, type ReactNode } from 'react'
import { FileGlyphIcon } from '../ui/icons'
import { formatMaybeDuration, toolFilePath } from './activity-model'
import {
  formatToolInput,
  formatToolResult,
  liveToolStatusClass,
  shortActivityText,
} from './task-progress-indicator'
import type { LiveToolEvent } from './types'


export function AgentToolRow({
  tool,
  now,
  onOpenFile,
}: {
  tool: LiveToolEvent
  now: number
  onOpenFile?: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const statusClass = liveToolStatusClass(tool)
  const action = toolActionLabel(tool.name)
  const displayAction = action === '调用' ? tool.name : action
  const title = tool.ok === false ? `${displayAction}失败` : displayAction
  const targetPath = toolFilePath(tool.input)
  const inputText = formatToolInput(tool)
  const outputText = tool.error ? '' : formatToolResult(tool)
  const errorText = tool.error ? firstLine(tool.error) : ''
  const hasDetails = Boolean(targetPath || inputText || outputText || errorText)
  const summary = errorText || toolSummaryText(tool)
  const running = tool.ok === undefined

  return (
    <section className={`agent-tool-call ${statusClass} ${open ? 'open' : ''}`} data-call-id={tool.callId}>
      <button
        type="button"
        className={`agent-flow-row agent-tool-row ${running ? 'is-active' : ''} ${hasDetails ? '' : 'no-details'}`}
        aria-label={`${title}${summary ? `，${summary}` : ''}`}
        {...(hasDetails ? { 'aria-expanded': open } : {})}
        onClick={() => {
          if (hasDetails) setOpen((value) => !value)
        }}
      >
        <span className="agent-tool-glyph" aria-hidden="true">
          {targetPath ? <FileGlyphIcon name={targetPath} /> : <span className="agent-tool-generic-glyph" />}
        </span>
        <span className={`agent-flow-title ${running ? 'is-running' : ''}`}>{title}</span>
        <span className="agent-flow-separator" aria-hidden="true" />
        <span className={`agent-flow-summary ${errorText ? 'is-error' : ''}`}>
          {summary}
        </span>
        <span className="agent-flow-meta">{formatMaybeDuration(tool.startedAt, tool.endedAt, now)}</span>
        <span className={`agent-flow-chevron ${hasDetails && open ? 'open' : ''}`} aria-hidden="true" />
        {running && (
          <span className="agent-flow-sr-only" role="status" aria-live="polite">
            正在{displayAction}{summary ? `：${summary}` : ''}
          </span>
        )}
      </button>
      {hasDetails && (
        <div
          className={`agent-tool-details-panel disclosure-panel ${open ? 'open' : ''}`}
          aria-hidden={!open}
          {...(!open ? { inert: '' } : {})}
        >
          <div className="agent-tool-details-panel-inner">
            <div className="agent-tool-details">
              {targetPath && onOpenFile && (
                <button
                  type="button"
                  className="agent-tool-file-action"
                  onClick={() => onOpenFile(targetPath)}
                >
                  <FileGlyphIcon name={targetPath} />
                  <span>{targetPath}</span>
                </button>
              )}
              {inputText && (
                <ToolDetailSection label="IN">
                  <pre>{inputText}</pre>
                </ToolDetailSection>
              )}
              {outputText && (
                <ToolDetailSection label="OUT">
                  <pre>{outputText}</pre>
                </ToolDetailSection>
              )}
              {errorText && (
                <ToolDetailSection label="ERROR" error>
                  <pre>{tool.error}</pre>
                </ToolDetailSection>
              )}
              {!inputText && !outputText && !errorText && !targetPath && (
                <div className="agent-tool-details-empty">暂无可展开内容。</div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}


function ToolDetailSection({
  label,
  error = false,
  children,
}: {
  label: string
  error?: boolean
  children: ReactNode
}) {
  return (
    <section className={`agent-tool-detail-section ${error ? 'error' : ''}`}>
      <div className="agent-tool-detail-label">{label}</div>
      {children}
    </section>
  )
}


export function toolActionLabel(name: string): string {
  const lower = name.toLowerCase()
  if (/(?:read|cat|open|load|inspect|stat)/u.test(lower)) return '读取'
  if (/(?:write|edit|patch|create|save|append)/u.test(lower)) return '修改'
  if (/(?:exec|shell|command|terminal|run)/u.test(lower)) return '运行'
  if (/(?:grep|glob|search|find|list|scan)/u.test(lower)) return '搜索'
  if (/(?:browser|fetch|http|web|url)/u.test(lower)) return '浏览'
  if (/(?:delete|remove|trash)/u.test(lower)) return '删除'
  return '调用'
}


export function toolSummaryText(tool: LiveToolEvent): string {
  const record = isRecord(tool.input) ? tool.input : undefined
  const targetPath = toolFilePath(tool.input)
  const command = record?.command
  if (typeof command === 'string' && command.trim()) {
    return shortActivityText(`$ ${command}`, 180)
  }

  const query = firstString(record, ['query', 'pattern', 'glob', 'url', 'href'])
  if (query && targetPath) return shortActivityText(`${query} · ${targetPath}`, 180)
  if (targetPath) return shortActivityText(targetPath, 180)
  if (query) return shortActivityText(query, 180)

  return shortActivityText(formatToolInput(tool).replace(/\s+/gu, ' ').trim(), 180)
}


function firstString(record: Record<string, unknown> | undefined, keys: string[]): string {
  if (!record) return ''
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}


function firstLine(value: string): string {
  return value.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? ''
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
