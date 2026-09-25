// "What did the running page report?" — a compact, expandable readout of the guest's
// own diagnostics (UX-26 item 3).
//
// Running a workspace page must not require DevTools: a thrown script, a 404 asset or
// a document that refused to load all show up here, next to the run controls, with
// the raw message available behind a disclosure. Counts come from Main's bounded
// record (`/browser/diagnostics`), never from re-parsing the page.
import { useEffect, useState } from 'react'
import { getBrowserDiagnostics, type BrowserDiagnostics } from '../api/browser'
import { workspaceErrorMessage } from './workspace-errors'

/** How often the notice re-reads the record while a page is running. */
const POLL_INTERVAL_MS = 4_000

const KIND_LABELS: Record<string, string> = {
  script: '脚本报错',
  resource: '资源失败',
  navigation: '页面加载失败',
  console: '页面提示',
}

export function summarizeBrowserDiagnostics(diagnostics: BrowserDiagnostics | null): string {
  if (!diagnostics) return ''
  const parts = (['script', 'resource', 'navigation'] as const)
    .filter((kind) => (diagnostics.counts[kind] ?? 0) > 0)
    .map((kind) => `${KIND_LABELS[kind]} ${diagnostics.counts[kind]}`)
  return parts.join(' · ')
}

export function WorkspaceRunDiagnostics({ url }: { url: string }) {
  const [diagnostics, setDiagnostics] = useState<BrowserDiagnostics | null>(null)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!url) return undefined
    let cancelled = false
    const read = async () => {
      try {
        const next = await getBrowserDiagnostics(url)
        if (!cancelled) {
          setDiagnostics(next)
          setError('')
        }
      } catch (err) {
        if (!cancelled) setError(workspaceErrorMessage(err, '无法读取页面诊断。'))
      }
    }
    void read()
    const timer = window.setInterval(() => { void read() }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [url])

  const summary = summarizeBrowserDiagnostics(diagnostics)
  const entries = diagnostics?.entries ?? []
  if (error) {
    return <p className="workspace-preview-run-message" role="status">{error}</p>
  }
  if (!summary) {
    return (
      <p className="workspace-preview-run-diagnostics-clean" role="status">
        运行中：页面暂未报告脚本错误或资源失败。
      </p>
    )
  }
  return (
    <div className="workspace-preview-run-diagnostics" role="status">
      <button
        className="workspace-files-text-btn"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {summary}（{expanded ? '收起' : '查看详情'}）
      </button>
      {expanded && (
        <ul className="workspace-preview-run-diagnostics-list">
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              <b>{KIND_LABELS[entry.kind] ?? entry.kind}</b>
              <span>{entry.message}</span>
              {entry.sourceId && <i>{entry.sourceId}{entry.lineNumber > 0 ? `:${entry.lineNumber}` : ''}</i>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
