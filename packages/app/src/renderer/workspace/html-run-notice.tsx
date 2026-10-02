// Run state shown next to the HTML preview toolbar.
//
// It lives outside `preview-actions.tsx` on purpose: the toolbar carries no run controls any more —
// previewing an HTML file starts the local service by itself — so this notice only reports what the
// service did, what the page itself reported, and whether the reader is looking at a draft that the
// served page cannot show yet.
import { FeedbackNotice } from '../ui/feedback-notice'
import { htmlRunBusy, htmlRunFeedback, type HtmlRunState } from './html-run'
import { WorkspaceRunDiagnostics } from './run-diagnostics'

export function HtmlRunNotice({
  run,
  draftUnsaved = false,
}: {
  run: HtmlRunState
  /** True while the editor holds changes the served page cannot see. */
  draftUnsaved?: boolean
}) {
  const feedback = htmlRunFeedback(run)
  const running = run.status === 'running' && Boolean(run.url)
  // A healthy run shows nothing at all: no success banner, and no "no errors" line. What earns a
  // place here is a failure, an unsaved draft, or something the page itself reported — otherwise
  // the bar collapses to nothing and ordinary use carries no extra label (reported 2026-10-02).
  if (!feedback && !draftUnsaved && !running) return null
  return (
    <div className="workspace-preview-run">
      {feedback && (
        <FeedbackNotice
          feedback={feedback}
          className="workspace-preview-run-notice"
          busy={htmlRunBusy(run)}
        />
      )}
      {draftUnsaved && (
        <span className="workspace-preview-run-message" role="status">
          页面运行的是磁盘上的已保存版本；保存后会自动重新加载。
        </span>
      )}
      {/* UX-26: a running page reports its own script errors and failed resources
          here, so the user never has to open DevTools to find out. Silent when clean. */}
      {running ? <WorkspaceRunDiagnostics url={run.url} /> : null}
    </div>
  )
}
