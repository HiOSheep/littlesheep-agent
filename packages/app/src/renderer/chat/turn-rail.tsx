import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FloatingHelpTip } from '../ui/floating-help'
import type { RailEntry } from './turn-navigation'
import { filterNavigationTurns, navigationTurns } from './navigation-model'

export function TurnRail({ entries, activeKey, onJump, onTipChange }: {
  entries: readonly RailEntry[]
  activeKey: string | null
  overlapsText: boolean
  onJump: (key: string) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const root = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const panelId = useId()
  const turns = useMemo(() => navigationTurns(entries), [entries])
  const visible = useMemo(() => filterNavigationTurns(turns, query), [turns, query])
  const current = turns.find((turn) => activeKey && turn.keys.includes(activeKey))
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }) }

  useEffect(() => {
    if (!open) return
    search.current?.focus({ preventScroll: true })
    root.current?.querySelector('.chat-turn-entry[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])

  return (
    <nav ref={root} className="chat-turn-rail" aria-label="对话目录"
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
        if (!open) { onTipChange(null); setQuery(''); setOpen(true); return }
        const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('.chat-turn-entry') ?? [])
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const active = buttons.findIndex((button) => button.getAttribute('aria-current') === 'true')
        const next = inSearch ? (active >= 0 ? active : event.key === 'ArrowUp' ? buttons.length - 1 : 0)
          : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
        buttons[next]?.focus({ preventScroll: true })
        buttons[next]?.scrollIntoView({ block: 'nearest' })
      }}>
      <button ref={trigger} type="button" className="chat-turn-trigger" aria-label="打开对话目录"
        aria-expanded={open} aria-controls={panelId}
        onClick={() => { onTipChange(null); setQuery(''); setOpen(!open) }}>
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <path d="M5 4H13M5 8H13M5 12H13M2 4H2.1M2 8H2.1M2 12H2.1" />
        </svg>
        <span>目录</span><span className="chat-turn-position">{current?.turn ?? turns[0]?.turn ?? 1} / {turns.at(-1)?.turn ?? 0}</span>
      </button>
      {open && <div id={panelId} className="chat-turn-panel">
        <div className="chat-turn-heading"><strong>对话目录</strong><button type="button" aria-label="关闭对话目录" onClick={close}>×</button></div>
        <input ref={search} className="chat-turn-search" type="search" aria-label="搜索轮次与内容摘要"
          placeholder="搜索轮次或内容摘要…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="chat-turn-list" aria-label="对话轮次">
          {visible.map((turn) => <button key={turn.key} type="button" className="chat-turn-entry"
            aria-label={`第 ${turn.turn} 轮：${turn.question || turn.answer}`} aria-current={activeKey && turn.keys.includes(activeKey) ? 'true' : undefined}
            onClick={() => { onJump(turn.key); close() }}>
            <span className="chat-turn-number">{turn.turn}</span>
            <span className="chat-turn-summary"><strong>{turn.question || '回答'}</strong>{turn.answer && <span>{turn.answer}</span>}</span>
          </button>)}
          {visible.length === 0 && <div className="chat-turn-empty" role="status">没有匹配的轮次</div>}
        </div>
        <div className="chat-turn-footer">{visible.length} 轮 · ↑↓ 选择 · Enter 跳转 · Esc 关闭</div>
      </div>}
    </nav>
  )
}
