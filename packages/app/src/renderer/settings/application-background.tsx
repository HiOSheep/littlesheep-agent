import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeActiveRunAction, RuntimeActiveRunSnapshot } from '@littlesheep/types'
import type { RuntimeState } from '../api'
import { controlActiveRun, listActiveRuns, subscribeActiveRuns } from '../api/application-lifecycle'
import { RefreshIcon } from '../ui/icons'
import { ActiveRunRow } from './active-run-row'
import {
  CLOSE_POLICY_OPTIONS,
  replaceActiveRun,
} from './application-background-state'

const ACTIVE_RUN_RECONNECT_DELAY_MS = 5_000

type RefreshMode = 'initial' | 'manual' | 'sync'

export function SettingsApplicationBackgroundPage({
  closePolicy,
  onClosePolicyChange,
}: {
  closePolicy: RuntimeState['closePolicy'] | null
  onClosePolicyChange: (policy: RuntimeState['closePolicy']) => Promise<boolean>
}) {
  const [runs, setRuns] = useState<RuntimeActiveRunSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [savingPolicy, setSavingPolicy] = useState<RuntimeState['closePolicy'] | null>(null)
  const [busyRun, setBusyRun] = useState<{ runId: string; action: RuntimeActiveRunAction } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const aliveRef = useRef(true)
  const requestInFlightRef = useRef(false)
  const requestAbortRef = useRef<AbortController | null>(null)

  const loadRuns = useCallback(async (mode: RefreshMode) => {
    if (requestInFlightRef.current) return
    requestInFlightRef.current = true
    if (mode === 'initial') setLoading(true)
    if (mode === 'manual') setRefreshing(true)
    const controller = new AbortController()
    requestAbortRef.current = controller
    try {
      const next = await listActiveRuns(controller.signal)
      if (!aliveRef.current) return
      setRuns(next)
      setError('')
    } catch (cause) {
      if (!aliveRef.current || isAbortError(cause)) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null
      requestInFlightRef.current = false
      if (aliveRef.current) {
        if (mode === 'initial') setLoading(false)
        if (mode === 'manual') setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    let streamController: AbortController | null = null
    let reconnectTimer: number | null = null
    let stopped = false
    const connect = async () => {
      if (stopped) return
      streamController = new AbortController()
      try {
        await subscribeActiveRuns(streamController.signal, (next) => {
          if (!aliveRef.current) return
          setRuns(next)
          setLoading(false)
          setError('')
        })
        if (!stopped) throw new Error('活动任务连接已断开。')
      } catch (cause) {
        if (stopped || isAbortError(cause)) return
        if (aliveRef.current) {
          setError(cause instanceof Error ? cause.message : String(cause))
          await loadRuns('initial')
        }
        if (!stopped) reconnectTimer = window.setTimeout(() => void connect(), ACTIVE_RUN_RECONNECT_DELAY_MS)
      }
    }
    void connect()
    return () => {
      stopped = true
      aliveRef.current = false
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      streamController?.abort()
      requestAbortRef.current?.abort()
      requestAbortRef.current = null
    }
  }, [loadRuns])

  async function changeClosePolicy(policy: RuntimeState['closePolicy']) {
    if (!closePolicy || savingPolicy || policy === closePolicy) return
    setSavingPolicy(policy)
    setError('')
    setNotice('')
    try {
      const saved = await onClosePolicyChange(policy)
      if (!aliveRef.current) return
      if (saved) {
        setNotice('窗口关闭方式已更新。')
      } else {
        setError('窗口关闭方式未能保存，请检查应用状态后重试。')
      }
    } finally {
      if (aliveRef.current) setSavingPolicy(null)
    }
  }

  async function controlRun(run: RuntimeActiveRunSnapshot, action: RuntimeActiveRunAction) {
    if (busyRun || run.controlStatus === 'interrupt_requested') return
    setBusyRun({ runId: run.runId, action })
    setError('')
    setNotice('')
    try {
      const outcome = await controlActiveRun(run.runId, action, 'settings-application-background')
      if (!aliveRef.current) return
      if (outcome.kind === 'rejected') {
        setError(controlRejectionMessage(outcome.reason, outcome.message))
      } else {
        setRuns((current) => replaceActiveRun(current, outcome.run))
        setNotice(controlAcceptedMessage(action))
      }
      await loadRuns('sync')
    } catch (cause) {
      if (aliveRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (aliveRef.current) setBusyRun(null)
    }
  }

  return (
    <div className="settings-module-page application-background-page">
      <header className="settings-module-heading">
        <div className="settings-module-kicker">通用</div>
        <h2>应用与后台</h2>
        <p>控制关闭窗口后的应用行为，并查看和管理 Runtime 当前仍在执行的真实任务。</p>
      </header>

      <section className="application-background-section" aria-labelledby="close-policy-heading">
        <div className="application-background-section-heading">
          <span>
            <strong id="close-policy-heading">关闭窗口时</strong>
            <small>行为立即生效，不改变 Agent 行为配置或权限模式</small>
          </span>
          <span>{closePolicy ? '已同步' : '读取中'}</span>
        </div>
        <div className="profile-choice-list application-close-policy-list" role="radiogroup" aria-label="窗口关闭方式">
          {CLOSE_POLICY_OPTIONS.map((option) => {
            const active = option.id === closePolicy
            const saving = option.id === savingPolicy
            return (
              <button
                key={option.id}
                type="button"
                className={`profile-choice ${active ? 'active' : ''}`}
                role="radio"
                aria-checked={active}
                disabled={!closePolicy || !!savingPolicy}
                onClick={() => void changeClosePolicy(option.id)}
              >
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                <span className="profile-choice-check" aria-hidden="true">{saving ? '…' : active ? '✓' : ''}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="application-background-section" aria-labelledby="active-runs-heading">
        <div className="application-background-section-heading active-runs-heading-row">
          <span>
            <strong id="active-runs-heading">活动任务</strong>
            <small>页面打开时自动同步；这里只展示 Runtime 返回的有界状态</small>
          </span>
          <button
            className="application-background-refresh"
            type="button"
            onClick={() => void loadRuns('manual')}
            disabled={refreshing}
            title="刷新活动任务"
            aria-label="刷新活动任务"
          >
            <RefreshIcon />
          </button>
        </div>

        {loading && <div className="application-background-empty">正在读取活动任务...</div>}
        {!loading && runs.length === 0 && (
          <div className="application-background-empty">
            <strong>当前没有活动任务</strong>
            <span>新任务开始后会自动出现在这里。</span>
          </div>
        )}
        {!loading && runs.length > 0 && (
          <div className="active-run-list">
            {runs.map((run) => (
              <ActiveRunRow
                key={run.runId}
                run={run}
                busyAction={busyRun?.runId === run.runId ? busyRun.action : null}
                controlsLocked={busyRun !== null}
                onControl={(action) => void controlRun(run, action)}
              />
            ))}
          </div>
        )}
      </section>

      {notice && <div className="storage-settings-notice" role="status">{notice}</div>}
      {error && <div className="storage-settings-notice" data-tone="error" role="alert">{error}</div>}
    </div>
  )
}

function controlAcceptedMessage(action: RuntimeActiveRunAction): string {
  if (action === 'pause') return '暂停请求已交给 Runtime，将在安全边界生效。'
  if (action === 'resume') return '继续请求已交给 Runtime。'
  return '中断请求已交给 Runtime，正在安全收尾。'
}

function controlRejectionMessage(reason: string, message: string): string {
  if (reason === 'run-not-active') return '任务已经结束，列表将自动刷新。'
  if (reason === 'action-conflict') return '任务正在处理另一项控制请求，请稍后再试。'
  return message || 'Runtime 未接受这次控制请求。'
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError'
}
