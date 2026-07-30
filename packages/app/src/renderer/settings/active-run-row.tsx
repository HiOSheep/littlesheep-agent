// Compact active-run presentation; detailed identifiers and steps stay progressively disclosed.
import type { RuntimeActiveRunAction, RuntimeActiveRunSnapshot } from '@littlesheep/types'
import { StopRunIcon } from '../ui/icons'
import {
  activeRunOriginLabel,
  activeRunProgress,
  activeRunStatusLabel,
  primaryActiveRunAction,
} from './application-background-state'

export function ActiveRunRow({
  run,
  busyAction,
  controlsLocked,
  onControl,
}: {
  run: RuntimeActiveRunSnapshot
  busyAction: RuntimeActiveRunAction | null
  controlsLocked: boolean
  onControl: (action: RuntimeActiveRunAction) => void
}) {
  const progress = activeRunProgress(run)
  const primaryAction = primaryActiveRunAction(run)
  const title = run.activeSteps[0]?.title ?? activeRunStatusLabel(run)
  const controlsDisabled = controlsLocked || run.controlStatus === 'interrupt_requested'

  return (
    <article className="active-run-row">
      <div className="active-run-summary">
        <div className="active-run-state">
          <span className="active-run-indicator" data-status={run.controlStatus} aria-hidden="true" />
          <span>
            <strong>{title}</strong>
            <small>
              {activeRunOriginLabel(run.origin)} · {progress.label}
              {run.activeToolCount > 0 ? ` · ${run.activeToolCount} 个工具运行中` : ''}
            </small>
          </span>
        </div>
        <div className="active-run-actions">
          {primaryAction && (
            <button
              type="button"
              onClick={() => onControl(primaryAction)}
              disabled={controlsDisabled}
              title={primaryAction === 'pause' ? '暂停任务' : '继续任务'}
              aria-label={primaryAction === 'pause' ? '暂停任务' : '继续任务'}
            >
              {primaryAction === 'pause' ? <PauseRunIcon /> : <ResumeRunIcon />}
              <span>{busyAction === primaryAction ? '处理中' : primaryAction === 'pause' ? '暂停' : '继续'}</span>
            </button>
          )}
          <button
            className="danger"
            type="button"
            onClick={() => onControl('interrupt')}
            disabled={controlsDisabled}
            title="中断任务"
            aria-label="中断任务"
          >
            <StopRunIcon />
            <span>{busyAction === 'interrupt' ? '处理中' : '中断'}</span>
          </button>
        </div>
      </div>

      {progress.ratio !== null && (
        <div className="active-run-progress" aria-label={`任务进度 ${progress.label}`}>
          <span style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
        </div>
      )}

      <details className="active-run-details">
        <summary>查看运行详情</summary>
        <dl>
          <div><dt>状态</dt><dd>{activeRunStatusLabel(run)}</dd></div>
          <div><dt>会话</dt><dd title={String(run.sessionId)}>{String(run.sessionId)}</dd></div>
          <div><dt>运行</dt><dd title={run.runId}>{run.runId}</dd></div>
          <div><dt>开始</dt><dd>{formatRuntimeTime(run.startedAt)}</dd></div>
          <div><dt>更新</dt><dd>{formatRuntimeTime(run.updatedAt)}</dd></div>
        </dl>
        {run.activeSteps.length > 0 && (
          <div className="active-run-steps">
            <strong>当前步骤</strong>
            {run.activeSteps.map((step) => <span key={step.stepId}>{step.title ?? step.stepId}</span>)}
          </div>
        )}
      </details>
    </article>
  )
}

function PauseRunIcon() {
  return (
    <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5.25 3.5v9M10.75 3.5v9" />
    </svg>
  )
}

function ResumeRunIcon() {
  return (
    <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="m5.25 3.4 7 4.6-7 4.6z" />
    </svg>
  )
}

function formatRuntimeTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : value
}
