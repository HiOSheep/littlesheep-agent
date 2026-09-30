// 设置 → 界面：显示密度、字号、主题和有限的主题色偏好。
import { useEffect, useMemo, useState } from 'react'
import { SettingsSelect } from './select'
import { SettingRow } from './setting-row'
import { APPEARANCE_DEFAULTS, APPEARANCE_PALETTES, APPEARANCE_PREFERENCES_EVENT,
  appearanceColorsAreReadable, applyAppearancePreferences, bestReadableText, normalizeHex,
  readAppearancePreferences, writeAppearancePreferences,
  type AppearanceColors, type AppearancePalette, type AppearancePreferences,
  type AppearancePreferencesEventDetail, type AppearanceThemeMode } from '../app-shell/appearance-preferences'
import { readConversationDisplayMode, writeConversationDisplayMode, type ConversationDisplayMode } from '../chat/conversation-display'

type ColorDraft = Record<ColorField, string>
type ColorField = keyof AppearanceColors

function initialCustomColors(preferences: AppearancePreferences): AppearanceColors {
  if (preferences.palette === 'custom') return preferences.colors
  if (document.documentElement.dataset.lsTheme === 'light') {
    const accent = preferences.palette === 'forest' ? '#28724a' : preferences.palette === 'ocean' ? '#176b98' : '#343431'
    return { accent, background: '#f2f2f0', surface: '#fafaf9' }
  }
  return APPEARANCE_PALETTES[preferences.palette]
}

export function SettingsAppearancePage() {
  const [preferences, setPreferences] = useState(readAppearancePreferences)
  const [conversationDisplay, setConversationDisplay] = useState<ConversationDisplayMode>(readConversationDisplayMode)
  const [customOpen, setCustomOpen] = useState(false)
  const [colorDraft, setColorDraft] = useState<ColorDraft>(() => initialCustomColors(preferences))
  const [savedNote, setSavedNote] = useState('')

  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<AppearancePreferencesEventDetail>).detail
      if (detail?.persisted && detail.preferences.version === 1) setPreferences(detail.preferences)
    }
    document.documentElement.addEventListener(APPEARANCE_PREFERENCES_EVENT, sync)
    return () => document.documentElement.removeEventListener(APPEARANCE_PREFERENCES_EVENT, sync)
  }, [])

  const parsedDraft = useMemo(() => {
    const accent = normalizeHex(colorDraft.accent)
    const background = normalizeHex(colorDraft.background)
    const surface = normalizeHex(colorDraft.surface)
    return accent && background && surface ? { accent, background, surface } : null
  }, [colorDraft])
  const readableDraft = parsedDraft !== null && appearanceColorsAreReadable(parsedDraft)

  function save(patch: Partial<AppearancePreferences>) {
    const result = writeAppearancePreferences({ ...preferences, ...patch })
    const next = result.preferences
    setPreferences(next)
    setSavedNote(result.persisted ? '已保存并生效' : '保存失败；当前窗口已应用这些设置，请重试后再关闭应用')
  }

  function setTheme(theme: AppearanceThemeMode) { save({ theme }) }
  function setFontSize(key: 'interfaceFontSize' | 'chatFontSize' | 'codeFontSize' | 'terminalFontSize', value: number) {
    save({ [key]: value })
  }

  function choosePalette(value: string) {
    const palette = value as AppearancePalette
    setSavedNote('')
    if (palette === 'custom') {
      const draft = initialCustomColors(preferences)
      setColorDraft(draft)
      setCustomOpen(true)
      applyAppearancePreferences({ ...preferences, palette: 'custom', colors: draft })
      return
    }
    setCustomOpen(false)
    save({ palette, colors: APPEARANCE_PALETTES[palette] })
  }

  function previewDraft(next: ColorDraft) {
    setColorDraft(next)
    const accent = normalizeHex(next.accent)
    const background = normalizeHex(next.background)
    const surface = normalizeHex(next.surface)
    if (accent && background && surface) {
      applyAppearancePreferences({ ...preferences, palette: 'custom', colors: { accent, background, surface } })
    } else {
      applyAppearancePreferences(preferences)
    }
  }

  function cancelCustomColors() {
    applyAppearancePreferences(preferences)
    setCustomOpen(false)
    setColorDraft(initialCustomColors(preferences))
  }

  function applyCustomColors() {
    if (!parsedDraft || !readableDraft) return
    const result = writeAppearancePreferences({ ...preferences, palette: 'custom', colors: parsedDraft })
    if (!result.persisted) {
      applyAppearancePreferences(preferences)
      setSavedNote('保存失败；预览已回退，颜色输入仍保留，请重试')
      return
    }
    setPreferences(result.preferences)
    setSavedNote('已保存并生效')
    setCustomOpen(false)
  }

  function restoreDefaults() {
    const result = writeAppearancePreferences(APPEARANCE_DEFAULTS)
    if (!result.persisted) {
      applyAppearancePreferences(preferences)
      setSavedNote('恢复失败；当前外观已保留，请检查本地存储后重试')
      return
    }
    const next = result.preferences
    setPreferences(next)
    setColorDraft(initialCustomColors(next))
    setCustomOpen(false)
    setSavedNote('外观已恢复默认')
  }

  return (
    <div className="settings-module-page appearance-settings-page">
      <header className="settings-module-heading">
        <div className="settings-module-kicker">通用</div>
        <h2>界面</h2>
        <p>调整阅读大小与主题。偏好会保存在此应用中，不改变 Agent 行为、权限或用量统计。</p>
      </header>

      <section className="settings-policy-section" aria-label="对话显示">
        <div className="settings-policy-heading"><strong>对话显示</strong><span>已完成轮次的过程内容</span></div>
        <div className="settings-card">
          <SettingRow field="appearance.conversation-display" title="对话显示密度" description="选择已完成轮次的过程内容如何显示。">
            <SettingsSelect label="对话显示模式" value={conversationDisplay}
              options={[{ value: 'normal', label: '普通' }, { value: 'compact', label: '紧凑' }]}
              onChange={mode => { const next = mode as ConversationDisplayMode; setConversationDisplay(next); writeConversationDisplayMode(next); setSavedNote('已保存并生效') }} />
          </SettingRow>
        </div>
      </section>

      <section className="settings-policy-section" aria-label="文字大小">
        <div className="settings-policy-heading"><strong>文字大小</strong><span>即刻预览</span></div>
        <div className="settings-card">
          <FontSizeRow field="appearance.interface-font-size" title="界面字号" value={preferences.interfaceFontSize} min={12} max={22}
            sample="设置标题、说明和常用控件" onChange={(value) => setFontSize('interfaceFontSize', value)} />
          <FontSizeRow field="appearance.chat-font-size" title="聊天字号" value={preferences.chatFontSize} min={12} max={22}
            sample="聊天正文预览：清晰阅读回复与列表。" onChange={(value) => setFontSize('chatFontSize', value)} />
        </div>
      </section>

      <section className="settings-policy-section" aria-label="主题">
        <div className="settings-policy-heading"><strong>主题</strong><span>覆盖聊天、工作区和弹层</span></div>
        <div className="settings-card">
          <SettingRow field="appearance.theme-mode" title="明暗模式" description="跟随系统会随操作系统的明暗设置切换。">
            <SettingsSelect label="明暗模式" value={preferences.theme}
              options={[{ value: 'system', label: '跟随系统' }, { value: 'dark', label: '深色' }, { value: 'light', label: '浅色' }]}
              onChange={(value) => setTheme(value as AppearanceThemeMode)} />
          </SettingRow>
          <SettingRow field="appearance.palette" title="配色" description="预设保留状态颜色含义；自定义颜色会先进入预览。">
            <div className="appearance-palette-control">
              <SettingsSelect label="主题配色" value={customOpen ? 'custom' : preferences.palette}
              options={[{ value: 'neutral', label: '中性' }, { value: 'ocean', label: '海蓝' }, { value: 'forest', label: '林绿' }, { value: 'custom', label: '自定义…' }]}
              onChange={choosePalette} />
              <button className="appearance-custom-open" type="button" onClick={() => choosePalette('custom')}>自定义颜色</button>
            </div>
          </SettingRow>
        </div>
        {customOpen && (
          <div className="appearance-custom-editor" aria-label="自定义配色预览">
            <div className="appearance-custom-fields">
              <SettingRow field="appearance.color-accent" title="强调色" description="用于焦点、选择与图表强度。">
                <ColorInput label="强调色" value={colorDraft.accent} onChange={(value) => previewDraft({ ...colorDraft, accent: value })} />
              </SettingRow>
              <SettingRow field="appearance.color-background" title="背景色" description="主窗口后方的基底颜色。">
                <ColorInput label="背景色" value={colorDraft.background} onChange={(value) => previewDraft({ ...colorDraft, background: value })} />
              </SettingRow>
              <SettingRow field="appearance.color-surface" title="面板色调" description="内容面板与玻璃浮层的基底颜色。">
                <ColorInput label="面板色调" value={colorDraft.surface} onChange={(value) => previewDraft({ ...colorDraft, surface: value })} />
              </SettingRow>
            </div>
            <div className="appearance-preview-sample" style={readableDraft && parsedDraft ? {
              color: bestReadableText([parsedDraft.background, parsedDraft.surface]),
              background: parsedDraft.background,
              borderColor: parsedDraft.accent,
            } : undefined}>
              <strong>配色预览</strong><span>文字、边框和状态提示会继续使用可读的颜色。</span>
            </div>
            {!parsedDraft && <p className="appearance-color-warning" role="alert">请输入完整的 #RRGGBB 颜色值。</p>}
            {parsedDraft && !readableDraft && <p className="appearance-color-warning" role="status">背景与面板对比不足，预览已回退为当前主题默认色；请调整其中一种颜色。</p>}
            <div className="appearance-custom-actions">
              <button type="button" onClick={cancelCustomColors}>取消</button>
              <button type="button" onClick={applyCustomColors} disabled={!readableDraft}>应用</button>
            </div>
          </div>
        )}
      </section>

      <details className="settings-advanced appearance-advanced">
        <summary>高级文字设置</summary>
        <div className="settings-card">
          <FontSizeRow field="appearance.code-font-size" title="代码字号" value={preferences.codeFontSize} min={11} max={22}
            sample="const ready = true" onChange={(value) => setFontSize('codeFontSize', value)} />
          <FontSizeRow field="appearance.terminal-font-size" title="终端字号" value={preferences.terminalFontSize} min={11} max={22}
            sample="$ ls" onChange={(value) => setFontSize('terminalFontSize', value)} />
        </div>
      </details>

      <div className="appearance-footer">
        <button type="button" onClick={restoreDefaults}>恢复外观默认值</button>
        {savedNote && <span role="status">{savedNote}</span>}
      </div>
    </div>
  )
}

function FontSizeRow({ field, title, value, min, max, sample, onChange }: {
  field: string; title: string; value: number; min: number; max: number; sample: string; onChange: (value: number) => void
}) {
  return (
    <SettingRow field={field} title={title} description={`${min}–${max}px`}>
      <div className="appearance-font-control">
        <input type="range" aria-label={title} min={min} max={max} step={1} value={value}
          onChange={(event) => onChange(Number(event.target.value))} />
        <output>{value}px</output>
        <span className="appearance-font-sample" style={{ fontSize: `${value}px` }}>{sample}</span>
      </div>
    </SettingRow>
  )
}

function ColorInput({ label, value, onChange }: {
  label: string; value: string; onChange: (value: string) => void
}) {
  return (
    <div className="appearance-color-input">
      <input type="color" aria-label={`${label}颜色选择器`} value={normalizeHex(value) ?? '#000000'}
        onChange={(event) => onChange(event.target.value)} />
      <input type="text" aria-label={`${label}颜色值`} value={value} maxLength={7} spellCheck={false}
        aria-invalid={!normalizeHex(value)} onChange={(event) => onChange(event.target.value)} />
    </div>
  )
}
