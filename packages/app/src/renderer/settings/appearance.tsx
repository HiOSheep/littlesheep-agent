import { useEffect, useRef, useState } from 'react'
import { SettingsSelect } from './select'
import { SettingRow } from './setting-row'
import { AppearanceColorPicker } from './appearance-color-picker'
import { APPEARANCE_DEFAULTS, APPEARANCE_PALETTES, APPEARANCE_PREFERENCES_EVENT,
  normalizeHex, resolveAppearanceColors,
  readAppearancePreferences, writeAppearancePreferences,
  type AppearanceColors, type AppearancePreferences, type AppearancePreferencesEventDetail } from '../app-shell/appearance-preferences'
import { readConversationDisplayMode, writeConversationDisplayMode, type ConversationDisplayMode } from '../chat/conversation-display'

function currentColors(preferences = readAppearancePreferences()): Required<AppearanceColors> {
  return resolveAppearanceColors(preferences)
}

export function SettingsAppearancePage() {
  const [preferences, setPreferences] = useState(readAppearancePreferences)
  const [conversationDisplay, setConversationDisplay] = useState<ConversationDisplayMode>(readConversationDisplayMode)
  const [colors, setColors] = useState(currentColors)
  const [savedNote, setSavedNote] = useState('')
  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<AppearancePreferencesEventDetail>).detail
      if (detail) setPreferences(detail.preferences)
      setColors(currentColors(detail?.preferences))
    }
    document.documentElement.addEventListener(APPEARANCE_PREFERENCES_EVENT, sync)
    return () => document.documentElement.removeEventListener(APPEARANCE_PREFERENCES_EVENT, sync)
  }, [])

  function save(patch: Partial<AppearancePreferences>) {
    const result = writeAppearancePreferences({ ...preferences, ...patch })
    setPreferences(result.preferences)
    setColors(currentColors(result.preferences))
    setSavedNote(result.persisted ? '已保存并生效' : '保存失败；当前窗口已应用，请重试后再关闭应用')
  }
  function changeColor(field: keyof AppearanceColors, value: string) {
    if (colors[field] === value) return true
    const next = { ...colors, [field]: value }
    save({ palette: 'custom', colors: next })
    return true
  }
  function choosePalette(value: string) {
    if (value === 'custom') { save({ palette: 'custom', colors }); return }
    const palette = value as 'neutral' | 'ocean' | 'forest'
    save({ palette, colors: APPEARANCE_PALETTES[palette] })
  }
  function restoreDefaults() {
    const result = writeAppearancePreferences(APPEARANCE_DEFAULTS)
    setPreferences(result.preferences)
    setColors(currentColors(result.preferences))
    setSavedNote(result.persisted ? '外观已恢复默认' : '恢复失败；当前窗口已应用默认值，请重试')
  }

  return <div className="settings-module-page appearance-settings-page">
    <header className="settings-module-heading"><h2>外观</h2></header>
    <section className="settings-policy-section appearance-visual" aria-label="视觉风格">
      <div className="settings-policy-heading"><strong>视觉风格</strong></div>
      <div className="settings-card appearance-mode-card">
        <SettingRow field="appearance.theme-mode" title="明暗模式">
          <div className="appearance-mode-options" role="group" aria-label="明暗模式">
            {([{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }] as const).map(mode =>
              <button key={mode.value} type="button" className="appearance-mode-option" aria-label={mode.label}
                aria-pressed={preferences.theme === mode.value} title={mode.label} onClick={() => save({ theme: mode.value })}>
                <span className={`appearance-mode-preview preview-${mode.value}`} aria-hidden="true">
                  <span className="appearance-mini-sidebar"><i /><i /><i /></span>
                  <span className="appearance-mini-chat"><i /><i /><i /><i /><b /></span>
                </span>
              </button>)}
          </div>
        </SettingRow>
      </div>
      <div className="settings-card appearance-colors-card">
        <SettingRow field="appearance.palette" title="配色">
          <SettingsSelect label="主题配色" value={preferences.palette}
            options={[{ value: 'neutral', label: 'LittleSheep' }, { value: 'ocean', label: '海蓝' }, { value: 'forest', label: '林绿' }, { value: 'custom', label: '自定义颜色' }]} onChange={choosePalette} />
        </SettingRow>
        <SettingRow field="appearance.color-accent" title="强调色">
          <ColorInput label="强调色" value={colors.accent} onChange={value => changeColor('accent', value)} />
        </SettingRow>
        <SettingRow field="appearance.color-background" title="背景色">
          <ColorInput label="背景色" value={colors.background} onChange={value => changeColor('background', value)} />
        </SettingRow>
        <SettingRow field="appearance.color-foreground" title="前景色">
          <ColorInput label="前景色" value={colors.foreground} onChange={value => changeColor('foreground', value)} />
        </SettingRow>
      </div>
    </section>
    <details className="settings-advanced appearance-advanced" open>
      <summary>高级</summary>
      <div className="settings-card">
        <FontSizeRow field="appearance.interface-font-size" title="界面字号" description="调整界面中的基础字号" value={preferences.interfaceFontSize} min={12} max={22} onChange={value => save({ interfaceFontSize: value })} />
        <FontSizeRow field="appearance.chat-font-size" title="聊天字号" description="调整聊天正文的基础字号" value={preferences.chatFontSize} min={12} max={22} onChange={value => save({ chatFontSize: value })} />
        <FontSizeRow field="appearance.code-font-size" title="代码字号" description="调整聊天和差异视图中代码使用的基础字号" value={preferences.codeFontSize} min={11} max={22} onChange={value => save({ codeFontSize: value })} />
        <FontSizeRow field="appearance.terminal-font-size" title="终端字号" description="调整工作区终端的基础字号" value={preferences.terminalFontSize} min={11} max={22} onChange={value => save({ terminalFontSize: value })} />
      </div>
      <div className="settings-card">
        <SettingRow field="appearance.reduced-motion" title="减少动态效果" description="减少动画效果或匹配系统设置">
          <div className="appearance-segments" role="group" aria-label="减少动态效果">
            {([{ value: 'system', label: '系统' }, { value: 'on', label: '开启' }, { value: 'off', label: '关闭' }] as const).map(option =>
              <button type="button" key={option.value} aria-pressed={preferences.reducedMotion === option.value}
                onClick={() => save({ reducedMotion: option.value })}>{option.label}</button>)}
          </div>
        </SettingRow>
        <SettingRow field="appearance.conversation-display" title="对话显示密度" description="选择已完成轮次的过程内容如何显示">
          <SettingsSelect label="对话显示模式" value={conversationDisplay} options={[{ value: 'normal', label: '普通' }, { value: 'compact', label: '紧凑' }]}
            onChange={mode => { const next = mode as ConversationDisplayMode; setConversationDisplay(next); writeConversationDisplayMode(next); setSavedNote('已保存并生效') }} />
        </SettingRow>
      </div>
      <div className="settings-card">
        <SettingRow field="appearance.color-surface" title="面板色调" description="调整内容面板与浮层的基底颜色">
          <ColorInput label="面板色调" value={colors.surface} onChange={value => changeColor('surface', value)} />
        </SettingRow>
      </div>
    </details>
    <div className="appearance-footer">
      <button type="button" onClick={restoreDefaults}>恢复外观默认值</button>
      {savedNote && <span role="status">{savedNote}</span>}
    </div>
  </div>
}

function FontSizeRow({ field, title, description, value, min, max, onChange }: {
  field: string; title: string; description: string; value: number; min: number; max: number; onChange: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  function commit() {
    const next = Number(draft)
    if (draft.trim() && Number.isFinite(next)) {
      const bounded = Math.round(Math.max(min, Math.min(max, next)))
      setDraft(String(bounded)); onChange(bounded)
    } else setDraft(String(value))
  }
  return <SettingRow field={field} title={title} description={description}>
    <div className="appearance-font-control">
      <input type="number" aria-label={title} min={min} max={max} step={1} value={draft}
        onChange={event => {
          const text = event.target.value
          setDraft(text)
          const next = Number(text)
          if (text.trim() && Number.isFinite(next) && next >= min && next <= max) onChange(Math.round(next))
        }} onBlur={commit}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
      <span>px</span>
    </div>
  </SettingRow>
}

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => boolean }) {
  const swatch = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value.toUpperCase())
  const [invalid, setInvalid] = useState(false)
  useEffect(() => { setDraft(value.toUpperCase()); setInvalid(false) }, [value])
  function commit() {
    const hex = normalizeHex(draft)
    if (!hex || !onChange(hex)) { setInvalid(true); return }
    setDraft(hex.toUpperCase()); setInvalid(false)
  }
  return <div className="appearance-color-input">
    <button ref={swatch} type="button" className="appearance-color-swatch" aria-label={`${label}颜色选择器`} aria-haspopup="dialog" aria-expanded={open}
      style={{ backgroundColor: value }} onClick={() => setOpen(current => !current)} />
    <input type="text" aria-label={`${label}颜色值`} value={draft} maxLength={7} spellCheck={false}
      aria-invalid={invalid} onChange={event => {
        const text = event.target.value
        setDraft(text); setInvalid(false)
        const hex = normalizeHex(text)
        if (hex) onChange(hex)
      }} onBlur={commit}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setDraft(value.toUpperCase()); setInvalid(false) } }} />
    {open && <AppearanceColorPicker label={label} value={value} anchor={swatch} onChange={onChange} onClose={() => setOpen(false)} />}
  </div>
}
