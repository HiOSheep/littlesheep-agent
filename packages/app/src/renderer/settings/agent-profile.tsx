// Settings navigation and page composition.
import { useEffect, useState } from 'react'
import {
  type AgentProfileId
} from '../api'
import { PROFILE_OPTIONS } from '../runtime/options'
import { failureFeedback, isFailureFeedback, successFeedback, type Feedback } from '../ui/feedback'
import { FeedbackNotice } from '../ui/feedback-notice'


export function SettingsAgentProfilePage({
  profile,
  contextCompressionThresholdRatio,
  onChange,
  onContextCompressionThresholdChange,
}: {
  profile: AgentProfileId
  contextCompressionThresholdRatio: number
  onChange: (profile: AgentProfileId) => void
  /** Resolves with the failure text, or null when the change was applied. */
  onContextCompressionThresholdChange: (ratio: number) => Promise<string | null>
}) {
  const [compressionThreshold, setCompressionThreshold] = useState(contextCompressionThresholdRatio)
  const [savingCompressionThreshold, setSavingCompressionThreshold] = useState(false)
  const [thresholdFeedback, setThresholdFeedback] = useState<Feedback | null>(null)

  useEffect(() => {
    setCompressionThreshold(contextCompressionThresholdRatio)
  }, [contextCompressionThresholdRatio])

  async function saveCompressionThreshold() {
    if (savingCompressionThreshold || compressionThreshold === contextCompressionThresholdRatio) return
    setSavingCompressionThreshold(true)
    setThresholdFeedback(null)
    try {
      const failure = await onContextCompressionThresholdChange(compressionThreshold)
      if (failure === null) {
        setThresholdFeedback(successFeedback(`压缩阈值已保存为 ${Math.round(compressionThreshold * 100)}%。`))
        return
      }
      // The Runtime text stays available, but the page states where the change
      // was made that it did not take effect.
      setThresholdFeedback(failureFeedback('压缩阈值未保存，仍在使用原来的比例', failure))
    } catch (cause) {
      setThresholdFeedback(failureFeedback('压缩阈值未保存，仍在使用原来的比例', cause))
    } finally {
      setSavingCompressionThreshold(false)
    }
  }

  return (
    <div className="settings-module-page">
      <header className="settings-module-heading">
        <div className="settings-module-kicker">通用</div>
        <h2>Agent 行为</h2>
        <p>这里选择系统提示词侧的行为配置；权限仍由输入栏的权限模式单独控制。</p>
      </header>
      <div className="profile-choice-list" role="radiogroup" aria-label="Agent 行为配置">
        {PROFILE_OPTIONS.map((item) => {
          const active = item.id === profile
          return (
            <button
              key={item.id}
              type="button"
              className={`profile-choice ${active ? 'active' : ''}`}
              role="radio"
              aria-checked={active}
              onClick={() => {
                if (!active) onChange(item.id)
              }}
            >
              <span>
                <strong>{item.label}</strong>
                <small>{item.desc}</small>
              </span>
              <span className="profile-choice-check" aria-hidden="true">{active ? '✓' : ''}</span>
            </button>
          )
        })}
      </div>
      <section className="settings-policy-section" aria-label="上下文策略">
        <div className="settings-policy-heading">
          <strong>上下文</strong>
          <span>长期对话与模型窗口</span>
        </div>
        <details className="settings-advanced">
          <summary>高级上下文设置：压缩触发阈值</summary>
          <div className="settings-policy-row">
            <span>
              <strong>压缩触发阈值</strong>
              <small>达到模型上下文占用比例后生成可追溯摘要</small>
            </span>
            <input
              type="range"
              min="0.5"
              max="0.95"
              step="0.05"
              value={compressionThreshold}
              aria-label="上下文压缩触发阈值"
              onChange={(event) => setCompressionThreshold(Number(event.target.value))}
            />
            <output>{Math.round(compressionThreshold * 100)}%</output>
            <button
              type="button"
              onClick={() => void saveCompressionThreshold()}
              disabled={savingCompressionThreshold || compressionThreshold === contextCompressionThresholdRatio}
            >
              {savingCompressionThreshold ? '保存中' : '保存'}
            </button>
          </div>
          <FeedbackNotice
            feedback={thresholdFeedback}
            busy={savingCompressionThreshold}
            retryLabel="重试保存"
            onRetry={isFailureFeedback(thresholdFeedback) ? () => void saveCompressionThreshold() : undefined}
          />
        </details>
      </section>
    </div>
  )
}
