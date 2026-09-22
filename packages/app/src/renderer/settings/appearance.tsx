// Settings navigation and page composition.
// 设置 → 界面：显示密度和其它纯界面偏好。行为配置与权限不在这里。
import { useState } from 'react'
import {
  readConversationDisplayMode,
  writeConversationDisplayMode,
  type ConversationDisplayMode,
} from '../chat/conversation-display'


export function SettingsAppearancePage() {
  const [conversationDisplay, setConversationDisplay] = useState<ConversationDisplayMode>(readConversationDisplayMode)

  return (
    <div className="settings-module-page">
      <header className="settings-module-heading">
        <div className="settings-module-kicker">通用</div>
        <h2>界面</h2>
        <p>这里只放显示偏好：它改变信息怎么展示，不改变 Agent 行为或权限。</p>
      </header>
      <section className="settings-policy-section" aria-label="对话显示">
        <div className="settings-policy-heading">
          <strong>对话显示</strong>
          <span>已完成轮次的过程内容</span>
        </div>
        <div className="profile-choice-list compact-choice-list" role="radiogroup" aria-label="对话显示模式">
          {(['normal', 'compact'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`profile-choice ${conversationDisplay === mode ? 'active' : ''}`}
              role="radio"
              aria-checked={conversationDisplay === mode}
              onClick={() => {
                setConversationDisplay(mode)
                writeConversationDisplayMode(mode)
              }}
            >
              <span>
                <strong>{mode === 'normal' ? '普通' : '紧凑'}</strong>
                <small>{mode === 'normal' ? '显示已完成轮次的过程行与摘要' : '只显示折叠摘要与最终回复'}</small>
              </span>
              <span className="profile-choice-check" aria-hidden="true">{conversationDisplay === mode ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
