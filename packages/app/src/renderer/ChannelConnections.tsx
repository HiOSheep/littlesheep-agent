import { useEffect, useRef, useState } from 'react'
import { getChannelConnectionsStatus, reloadChannelConnections, type ChannelConnectionsStatus } from './api'
import { summarizeChannelConnections } from './channel-status'
import {
  failureFeedback,
  isFailureFeedback,
  successFeedback,
  type Feedback,
} from './ui/feedback'
import { FeedbackNotice } from './ui/feedback-notice'
import { useEscapeScope } from './ui/modal-surface'

interface ChannelConnectionsProps {
  onClose: () => void
  embedded?: boolean
}

export function ChannelConnections({ onClose, embedded = false }: ChannelConnectionsProps) {
  const [status, setStatus] = useState<ChannelConnectionsStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const mountedRef = useRef(true)
  const requestRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestRef.current += 1
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [])

  // Page-level scope: Escape closes this page only while nothing is stacked on
  // top of it (the delete confirmation, a popover, a dialog).
  useEscapeScope(onClose)

  async function loadStatus() {
    const requestId = ++requestRef.current
    setLoading(true)
    try {
      const next = await getChannelConnectionsStatus()
      if (!mountedRef.current || requestId !== requestRef.current) return
      setStatus(next)
      setLoadFailed(false)
      // A successful reload replaces the previous failure instead of leaving an
      // out-of-date success line next to it.
      setFeedback((current) => (current?.tone === 'error' ? null : current))
    } catch (e) {
      if (!mountedRef.current || requestId !== requestRef.current) return
      setLoadFailed(true)
      setStatus(null)
      setFeedback(failureFeedback('读取渠道状态失败，当前列表可能不是最新的', e))
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false)
    }
  }

  async function handleReload() {
    setReloading(true)
    setFeedback(null)
    try {
      await reloadChannelConnections()
      if (!mountedRef.current) return
      setFeedback(successFeedback('外部渠道已重新加载'))
      await loadStatus()
    } catch (e) {
      if (!mountedRef.current) return
      // The failure stays where the action was taken, with the same action
      // offered again; the technical text is bounded behind a disclosure.
      setFeedback(failureFeedback('重新加载外部渠道失败', e))
    } finally {
      if (mountedRef.current) setReloading(false)
    }
  }

  // The summary is derived from the same per-item running/failure facts the
  // list renders, so the badge cannot disagree with the rows below it.
  const overall = status ? summarizeChannelConnections(status) : null

  return (
    <div className="overlay" onClick={embedded ? undefined : onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          {/* One name for the feature: the navigation entry, the empty state and the
              feedback messages all say 外部渠道 (UX-12/UX-13 实机验收发现标题不一致). */}
          <h2>外部渠道</h2>
          {!embedded && <button className="dialog-close" onClick={onClose}>×</button>}
        </div>

        {loading && <div className="dialog-hint">正在加载...</div>}
        <FeedbackNotice
          feedback={feedback}
          busy={reloading || loading}
          retryLabel={isFailureFeedback(feedback) ? '重试' : undefined}
          onRetry={isFailureFeedback(feedback) ? () => void (loadFailed ? loadStatus() : handleReload()) : undefined}
        />

        {!loading && status && overall && (
          <>
            <div className="channel-overall">
              <span className={`channel-badge ${overall.kind}`} title={overall.detail}>
                {overall.label}
                {overall.counts && <small>{overall.counts}</small>}
              </span>
              <button className="refresh-btn" onClick={() => void loadStatus()} disabled={reloading}>
                刷新
              </button>
              <button className="reload-btn" onClick={() => void handleReload()} disabled={reloading}>
                {reloading ? '重新加载中...' : '重新加载'}
              </button>
            </div>

            {status.channels.length > 0 && (
              <div className="channel-section">
                <h3>已加载渠道 ({status.channels.length})</h3>
                {status.channels.map((ch, i) => (
                  <div key={i} className="channel-row">
                    <span className={`channel-dot ${ch.running ? 'on' : 'off'}`} />
                    <span className="channel-name">{ch.displayName}</span>
                    <span className="channel-type">{ch.type}</span>
                    <span className="channel-tag">{ch.running ? '运行中' : '未运行'}</span>
                  </div>
                ))}
              </div>
            )}

            {status.configured.length > 0 && (
              <div className="channel-section">
                <h3>已配置渠道 ({status.configured.length})</h3>
                {status.configured.map((c) => (
                  <div key={c.id} className="channel-row config">
                    <span className={`channel-dot ${c.enabled ? 'enabled' : 'disabled'}`} />
                    <span className="channel-name">{c.name ?? c.id}</span>
                    <span className="channel-type">{c.type}</span>
                    {!c.enabled && <span className="channel-tag">已禁用</span>}
                  </div>
                ))}
              </div>
            )}

            {status.failures.length > 0 && (
              <div className="channel-section channel-failures">
                <h3>需要处理 ({status.failures.length})</h3>
                {status.failures.map((failure) => (
                  <div key={failure.id} className="channel-row failure">
                    <span className="channel-dot off" />
                    <span className="channel-name">
                      <strong>{failure.id}</strong>
                      <small>{failure.error}</small>
                    </span>
                    <span className="channel-type">{failure.type}</span>
                  </div>
                ))}
              </div>
            )}

            {status.configured.length === 0 && (
              <div className="dialog-hint">
                还没有配置外部渠道，当前没有渠道可以运行。这个版本还没有渠道配置界面。
                <details className="feedback-detail">
                  <summary>在哪里配置</summary>
                  <p>
                    在应用数据目录的 <code>config.json</code> 里按 <code>channels.channels</code> 添加渠道，
                    保存后回到本页点“重新加载”。嵌套字段的完整含义见仓库的渠道插件说明。
                  </p>
                </details>
              </div>
            )}
          </>
        )}

        {!embedded && (
          <div className="dialog-footer">
            <button className="close-btn" onClick={onClose}>关闭</button>
          </div>
        )}
      </div>
    </div>
  )
}
