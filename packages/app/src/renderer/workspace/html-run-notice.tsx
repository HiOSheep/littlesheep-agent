// Run state shown next to the HTML preview toolbar: either the result of a run or
// the question asked before running an unsaved draft.
//
// It lives outside `preview-actions.tsx` on purpose: the toolbar itself must not
// grow a save affordance (the pane owns saving), so the one place that offers
// "save and run" is this notice.
import { FeedbackNotice } from '../ui/feedback-notice'
import { htmlRunBusy, htmlRunFeedback, type HtmlRunState } from './html-run'
import { WorkspaceRunDiagnostics } from './run-diagnostics'

export function HtmlRunNotice({
  run,
  prompt,
  onSaveAndRun,
  onCancel,
}: {
  run: HtmlRunState
  prompt: boolean
  onSaveAndRun: () => void
  onCancel: () => void
}) {
  const feedback = prompt ? null : htmlRunFeedback(run)
  if (!prompt && !feedback) return null
  if (!prompt && feedback) {
    return (
      <div className="workspace-preview-run">
        <FeedbackNotice
          feedback={feedback}
          className="workspace-preview-run-notice"
          busy={htmlRunBusy(run)}
        />
        {/* UX-26: a running page reports its own script errors and failed resources
            here, so the user never has to open DevTools to find out. */}
        {run.status === 'running' && run.url
          ? <WorkspaceRunDiagnostics url={run.url} />
          : null}
      </div>
    )
  }
  return (
    <div className="workspace-preview-run">
      <span className="workspace-preview-run-message" role="alert">
        有未保存的修改。运行使用磁盘上的已保存版本。
      </span>
      <button className="feedback-action" type="button" onClick={onSaveAndRun}>保存并运行</button>
      <button className="feedback-action" type="button" onClick={onCancel}>取消</button>
    </div>
  )
}
