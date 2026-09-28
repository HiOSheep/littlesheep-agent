import { SettingsSelect } from './select'
import { SettingRow } from './setting-row'
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
        <div className="settings-card">
        <SettingRow title="对话显示密度" description="选择已完成轮次的过程内容如何显示。">
          <SettingsSelect label="对话显示模式" value={conversationDisplay}
            options={[{ value: 'normal', label: '普通' }, { value: 'compact', label: '紧凑' }]}
            onChange={mode => { setConversationDisplay(mode); writeConversationDisplayMode(mode) }} />
        </SettingRow>
        </div>
      </section>
    </div>
  )
}
