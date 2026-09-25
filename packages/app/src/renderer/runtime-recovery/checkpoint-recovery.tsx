// Startup recovery dialog with progressive checkpoint inspection.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon, RefreshIcon } from '../ui/icons'
import { useModalSurface } from '../ui/modal-surface'
import { FadePresence } from '../ui/presence'
import {
  checkpointBlockerLabel,
  checkpointStageLabel,
  compactDuration,
} from './checkpoint-recovery-state'
import type { CheckpointRecoveryController } from './use-checkpoint-recovery'

const RECOVERY_MOTION_MS = 360

export function CheckpointRecovery({ recovery }: { recovery: CheckpointRecoveryController }) {
  const [confirmAbandon, setConfirmAbandon] = useState(false)
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const selected = recovery.selected
  useEffect(() => setConfirmAbandon(false), [selected?.id])

  // Escape means "later", never "abandon": closing the dialog only hides it, and
  // the layer is released as soon as the surface starts animating out.
  useModalSurface(dialogRef, {
    active: recovery.visible,
    onEscape: recovery.dismiss,
    initialFocusRef: closeRef,
  })

  return createPortal(<>
    {recovery.entry.kind !== 'none' && (
      <button
        type="button"
        className={`checkpoint-recovery-trigger ${recovery.entry.kind}`}
        title={recovery.entry.title}
        aria-hidden={recovery.visible || undefined}
        tabIndex={recovery.visible ? -1 : undefined}
        style={recovery.visible ? { pointerEvents: 'none' } : undefined}
        onClick={recovery.entry.action === 'retry' ? recovery.retryDiscovery : recovery.open}
      >
        <RefreshIcon />
        <span>{recovery.entry.label}</span>
        {recovery.entry.count > 0 && <strong>{recovery.entry.count}</strong>}
      </button>
    )}
    <FadePresence show={recovery.visible} exitMs={RECOVERY_MOTION_MS} className="checkpoint-recovery-presence">
      <div
        className="checkpoint-recovery-layer"
        role="presentation"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) recovery.dismiss()
        }}
      >
        <section
          ref={dialogRef}
          className="checkpoint-recovery-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="未完成任务恢复"
          tabIndex={-1}
        >
          <header className="checkpoint-recovery-header">
            <span>
              <small>启动恢复</small>
              <h2>未完成任务</h2>
            </span>
            <button ref={closeRef} type="button" aria-label="稍后处理" onClick={recovery.dismiss}>
              <CloseIcon />
            </button>
          </header>

          {recovery.checkpoints.length > 1 && (
            <nav className="checkpoint-recovery-list" aria-label="待恢复任务列表">
              {recovery.checkpoints.map((checkpoint) => (
                <button
                  type="button"
                  key={checkpoint.id}
                  className={checkpoint.id === selected?.id ? 'active' : ''}
                  onClick={() => recovery.selectCheckpoint(checkpoint.id)}
                  disabled={recovery.busy === 'resuming'}
                >
                  <span>{checkpoint.goal || '未命名任务'}</span>
                  <time>{formatCheckpointTime(checkpoint.createdAt)}</time>
                </button>
              ))}
            </nav>
          )}

          {selected ? (
            <div className="checkpoint-recovery-content">
              <div className="checkpoint-recovery-summary">
                <div className="checkpoint-recovery-state-line">
                  <span className={`checkpoint-state-dot ${selected.resumable ? 'ready' : 'blocked'}`} />
                  <strong>{selected.resumable ? '可以继续' : '需要处理'}</strong>
                  <span>{checkpointStageLabel(selected.currentStage)}</span>
                  <time>{formatCheckpointTime(selected.createdAt)}</time>
                </div>
                <h3>{selected.goal || selected.reason || '未完成任务'}</h3>
                {selected.workspace && <p className="checkpoint-recovery-path">{selected.workspace}</p>}
                <div className="checkpoint-recovery-metrics">
                  <span>{selected.progress.completedSteps}/{selected.progress.totalSteps || 0} 步完成</span>
                  <span>{selected.sideEffects.succeeded}/{selected.sideEffects.total} 项操作有完成证据</span>
                  <span>{selected.model || '模型信息不可用'}</span>
                </div>
              </div>

              {selected.blockers.length > 0 && (
                <div className="checkpoint-recovery-blockers" role="status">
                  {selected.blockers.map((reason) => <p key={reason}>{checkpointBlockerLabel(reason)}</p>)}
                </div>
              )}

              {selected.waitingForInput && (
                <label className="checkpoint-recovery-answer">
                  <span>补充信息</span>
                  <textarea
                    value={recovery.clarificationText}
                    onChange={(event) => recovery.setClarificationText(event.target.value)}
                    placeholder="补充继续执行所需的信息"
                    disabled={recovery.busy === 'resuming'}
                    autoFocus
                  />
                </label>
              )}

              {recovery.busy === 'resuming' && (
                <div className="checkpoint-recovery-progress" role="status" aria-live="polite">
                  <span className="checkpoint-recovery-spinner" aria-hidden="true" />
                  <span>
                    <strong>{recovery.stopRequested ? '正在停止并保存执行现场' : recovery.progress.label}</strong>
                    {!recovery.stopRequested && recovery.progress.detail && <small>{recovery.progress.detail}</small>}
                  </span>
                </div>
              )}

              {recovery.error && <div className="checkpoint-recovery-error">{recovery.error}</div>}
              {recovery.diagnosticText && (
                <p className="checkpoint-recovery-diagnostic">{recovery.diagnosticText}</p>
              )}

              <div className={`checkpoint-recovery-detail ${recovery.detailsOpen ? 'open' : ''}`}>
                {recovery.detailsOpen && recovery.detail && <CheckpointScene detail={recovery.detail} />}
                {recovery.detailsOpen && recovery.busy === 'inspecting' && (
                  <p className="checkpoint-recovery-detail-loading">正在读取现场…</p>
                )}
              </div>

              <footer className="checkpoint-recovery-actions">
                {confirmAbandon ? (
                  <div className="checkpoint-abandon-confirm">
                    <span>放弃后不会删除对话，但这个执行现场将不再续跑。</span>
                    <button type="button" onClick={() => setConfirmAbandon(false)}>返回</button>
                    <button type="button" className="danger" onClick={() => void recovery.abandonSelected()}>确认放弃</button>
                  </div>
                ) : recovery.busy === 'resuming' ? (
                  <button
                    type="button"
                    className="danger"
                    onClick={recovery.stopRecovery}
                    disabled={recovery.stopRequested}
                    aria-busy={recovery.stopRequested}
                  >
                    {recovery.stopRequested ? '正在停止…' : '停止恢复'}
                  </button>
                ) : (
                  <>
                    <button type="button" onClick={() => setConfirmAbandon(true)} disabled={Boolean(recovery.busy)}>放弃任务</button>
                    <button type="button" onClick={() => void recovery.toggleDetails()} disabled={Boolean(recovery.busy)}>
                      {recovery.detailsOpen ? '收起现场' : '查看现场'}
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={Boolean(recovery.busy) || !selected.resumable}
                      onClick={() => void recovery.resumeSelected()}
                    >
                      继续执行
                    </button>
                  </>
                )}
              </footer>
            </div>
          ) : (
            <div className="checkpoint-recovery-content">
              {recovery.discoveryFailed ? (
                <div className="checkpoint-recovery-error" role="alert">
                  未能读取未完成任务：{recovery.error ?? '原因未知'}
                </div>
              ) : null}
              {recovery.diagnosticText && (
                <p className="checkpoint-recovery-diagnostic">{recovery.diagnosticText}</p>
              )}
              <p className="checkpoint-recovery-empty">
                {recovery.discoveryFailed
                  ? '这次没有读取成功，未完成任务的当前状态未知。'
                  : '没有待处理的执行现场。'}
              </p>
              <footer className="checkpoint-recovery-actions">
                <button
                  type="button"
                  onClick={() => void recovery.retryDiscovery()}
                  disabled={Boolean(recovery.busy)}
                >
                  重新检查
                </button>
              </footer>
            </div>
          )}
        </section>
      </div>
    </FadePresence>
  </>, document.body)
}

function CheckpointScene({ detail }: { detail: NonNullable<CheckpointRecoveryController['detail']> }) {
  return (
    <div className="checkpoint-scene">
      <div className="checkpoint-scene-meta">
        <span>已运行 {compactDuration(detail.loopBudget.elapsedMs)}</span>
        <span>尝试 {detail.loopBudget.attemptsUsed}/{detail.loopBudget.maxAttempts}</span>
        <span>待处理事件 {detail.pendingEventCount}</span>
      </div>
      {detail.successCriteria.length > 0 && (
        <section>
          <h4>验收目标</h4>
          <ul>{detail.successCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
        </section>
      )}
      {detail.steps.length > 0 && (
        <section>
          <h4>任务步骤</h4>
          <ol className="checkpoint-scene-steps">
            {detail.steps.map((step) => (
              <li key={step.id} data-status={step.status}>
                <span>{step.title}</span>
                <small>{step.status}</small>
                {step.error && <p>{step.error}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}
      {detail.sideEffectDetails.length > 0 && (
        <section>
          <h4>操作证据</h4>
          <div className="checkpoint-scene-effects">
            {detail.sideEffectDetails.map((effect, index) => (
              <div key={`${effect.toolName}-${effect.stepId ?? index}`}>
                <span>{effect.toolName}</span>
                <small>{effect.status}</small>
                {effect.resourceKeys.map((resource) => <code key={resource}>{resource}</code>)}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function formatCheckpointTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
