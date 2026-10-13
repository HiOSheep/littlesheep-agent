import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FloatingHelpTip } from '../ui/floating-help'
import type { RailEntry } from './turn-navigation'
import { filterNavigationTurns, navigationTurns } from './navigation-model'
import { railEntryLabel, railScaleStep } from './turn-navigation'

export function TurnRail({ entries, activeKey, onJump, onTipChange }: {
  entries: readonly RailEntry[]
  activeKey: string | null
  overlapsText: boolean
  onJump: (key: string) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [query, setQuery] = useState('')
  const [pinned, setPinned] = useState(false)
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const [panelWidth, setPanelWidth] = useState(320)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const root = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const panelId = useId()
  const turns = useMemo(() => navigationTurns(entries), [entries])
  const filtered = useMemo(() => filterNavigationTurns(turns, query), [turns, query])
  const marks = useMemo(() => {
    const byKey = new Map(entries.map(entry => [entry.key, entry]))
    const representatives = turns.map(turn => byKey.get(turn.key)!)
    return representatives.length <= 64 ? representatives
      : Array.from({ length: 64 }, (_, index) => representatives[Math.round(index * (representatives.length - 1) / 63)]!)
  }, [entries, turns])
  const focusKey = hoverKey ?? activeKey
  const hoverTurn = entries.find(entry => entry.key === focusKey)?.turn
  const activeTurn = entries.find(entry => entry.key === activeKey)?.turn
  const exactIndex = marks.findIndex(entry => entry.turn === hoverTurn)
  const focusIndex = exactIndex >= 0 ? exactIndex : Math.max(0, marks.findIndex(entry => entry.turn >= (hoverTurn ?? 1)))
  const previewIndex = Math.max(0, turns.findIndex(turn => turn.turn === hoverTurn))
  const visible = pinned ? filtered : turns.slice(Math.max(0, previewIndex - 2), previewIndex + 3)
  const close = () => { setOpen(false); setPinned(false); trigger.current?.focus({ preventScroll: true }) }

  useEffect(() => () => clearTimeout(leaveTimer.current), [])
  useEffect(() => {
    const chat = root.current?.parentElement
    if (!chat) return
    const update = () => setPanelWidth(Math.max(180, Math.min(320, chat.clientWidth - 64)))
    const observer = new ResizeObserver(update)
    observer.observe(chat); update()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!open) return
    if (pinned) search.current?.focus({ preventScroll: true })
    root.current?.querySelector('.chat-turn-entry[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) { setOpen(false); setPinned(false) }
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open, pinned])

  return (
    <nav ref={root} className="chat-turn-rail" aria-label="对话目录" data-expanded={open} data-pinned={pinned}
      onMouseEnter={() => { clearTimeout(leaveTimer.current); setHovered(true); onTipChange(null); setOpen(true) }}
      onMouseLeave={() => { setHovered(false); leaveTimer.current = setTimeout(() => { if (!pinned) setOpen(false) }, 150) }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault(); event.stopPropagation(); close(); return
        }
        if (event.ctrlKey || event.metaKey || event.altKey) return
        const inSearch = event.target === search.current
        if (inSearch && !['ArrowDown', 'ArrowUp'].includes(event.key)) return
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        if (!open) { onTipChange(null); setQuery(''); setPinned(true); setOpen(true); return }
        const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('.chat-turn-entry') ?? [])
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const active = buttons.findIndex((button) => button.getAttribute('aria-current') === 'true')
        const next = inSearch ? (active >= 0 ? active : event.key === 'ArrowUp' ? buttons.length - 1 : 0)
          : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
        buttons[next]?.focus({ preventScroll: true })
        buttons[next]?.scrollIntoView({ block: 'nearest' })
      }}>
      <div className="chat-turn-marks" style={{ height: `min(${marks.length * 10}px, 34vh, 240px)` }}>{marks.map((entry, index) => <button key={entry.key} ref={index === 0 ? trigger : undefined}
        type="button" className="chat-turn-trigger" data-role={entry.role} aria-label={railEntryLabel(entry)}
        aria-current={entry.turn === activeTurn ? 'true' : undefined} aria-expanded={open} aria-controls={panelId}
        onMouseEnter={() => { clearTimeout(leaveTimer.current); setHoverKey(entry.key); setOpen(true) }} onFocus={() => setHoverKey(entry.key)}
        onClick={() => { onJump(entry.key); setOpen(false); setPinned(false) }}>
        <span aria-hidden="true" style={{ width: `${hovered ? [24, 18, 13, 9, 6][railScaleStep(focusIndex, index)] : 6}px` }} />
      </button>)}</div>
      {open && <div id={panelId} className="chat-turn-panel" style={{ width: panelWidth }}>
        {pinned && <div className="chat-turn-heading"><strong>对话目录</strong><button type="button" aria-label="关闭对话目录" onClick={close}>×</button></div>}
        {pinned && <input ref={search} className="chat-turn-search" type="search" aria-label="搜索轮次与内容摘要"
          placeholder="搜索轮次或内容摘要…" value={query} onChange={(event) => setQuery(event.target.value)} />}
        <div className="chat-turn-list" aria-label="对话轮次">
          {visible.map((turn) => <button key={turn.key} type="button" className="chat-turn-entry"
            aria-label={`第 ${turn.turn} 轮：${turn.question || turn.answer}`} aria-current={activeKey && turn.keys.includes(activeKey) ? 'true' : undefined}
            onClick={() => { onJump(turn.key); close() }}>
            <span className="chat-turn-number">{turn.turn}</span>
            <span className="chat-turn-summary"><strong>{turn.question || '回答'}</strong>{turn.answer && <span>{turn.answer}</span>}</span>
          </button>)}
          {visible.length === 0 && <div className="chat-turn-empty" role="status">没有匹配的轮次</div>}
        </div>
        {pinned ? <div className="chat-turn-footer">{visible.length} 轮 · ↑↓ 选择 · Enter 跳转 · Esc 关闭</div>
          : <button className="chat-turn-expand" type="button" onClick={() => { setQuery(''); setPinned(true) }}>查看全部 {turns.length} 轮</button>}
      </div>}
    </nav>
  )
}
