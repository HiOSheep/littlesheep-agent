// Primary navigation, project/session trees, and sidebar actions.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type SessionMeta
} from '../api'
import { formatRelativeSessionTime } from '../app-shell/list-motion'
import { SidebarPanel } from '../app-shell/types'
import { CloseIcon, SearchIcon } from '../ui/icons'
import { useDismissOnOutside } from '../ui/presence'


export function SidebarFeaturePanel({
  panel,
  search,
  sessions,
  currentSession,
  now,
  onSearchChange,
  onClose,
  onOpenSession,
}: {
  panel: SidebarPanel
  search: string
  sessions: SessionMeta[]
  currentSession?: string
  now: number
  onSearchChange: (value: string) => void
  onClose: () => void
  onOpenSession: (session: SessionMeta) => void
}) {
  const [renderedPanel, setRenderedPanel] = useState<SidebarPanel>(panel)
  const [visible, setVisible] = useState(false)
  const [contentVisible, setContentVisible] = useState(false)
  const panelRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const focusFrameRef = useRef<number>()

  useEffect(() => {
    let frame = 0
    let innerFrame = 0
    let timer = 0
    let swapTimer = 0

    if (panel) {
      if (renderedPanel && panel !== renderedPanel && visible) {
        setContentVisible(false)
        swapTimer = window.setTimeout(() => {
          setRenderedPanel(panel)
          frame = window.requestAnimationFrame(() => setContentVisible(true))
        }, 120)
      } else {
        setRenderedPanel(panel)
        frame = window.requestAnimationFrame(() => {
          setVisible(true)
          innerFrame = window.requestAnimationFrame(() => setContentVisible(true))
        })
      }
    } else {
      setContentVisible(false)
      setVisible(false)
      timer = window.setTimeout(() => setRenderedPanel(null), 180)
    }
    return () => {
      window.cancelAnimationFrame(frame)
      window.cancelAnimationFrame(innerFrame)
      window.clearTimeout(timer)
      window.clearTimeout(swapTimer)
    }
  }, [panel, renderedPanel, visible])

  useEffect(() => {
    if (renderedPanel === 'search' && visible && contentVisible) {
      window.cancelAnimationFrame(focusFrameRef.current ?? 0)
      focusFrameRef.current = window.requestAnimationFrame(() => {
        focusFrameRef.current = undefined
        searchRef.current?.focus()
      })
    }
    return () => window.cancelAnimationFrame(focusFrameRef.current ?? 0)
  }, [contentVisible, renderedPanel, visible])

  useDismissOnOutside(Boolean(renderedPanel && visible), [panelRef], onClose, 'click')

  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return sessions.slice(0, 8)
    return sessions.filter((session) => session.title.toLowerCase().includes(query)).slice(0, 24)
  }, [search, sessions])

  if (!renderedPanel) return null

  const title = '搜索'
  const desc = '搜索当前侧栏中的本地会话'

  return (
    <aside
      ref={panelRef}
      className={`sidebar-feature-panel ${visible ? 'visible' : ''}`}
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className={`sidebar-feature-content ${contentVisible ? 'visible' : ''}`}>
        <div className="sidebar-feature-header">
          <span>
            <strong>{title}</strong>
            <small>{desc}</small>
          </span>
          <button className="sidebar-feature-close" type="button" aria-label="关闭" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="sidebar-search-panel">
          <label className="sidebar-search-box">
            <SearchIcon />
            <input
              ref={searchRef}
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="搜索会话"
            />
          </label>
          <div className="sidebar-search-results" role="listbox" aria-label="搜索结果">
            {searchResults.length > 0 ? (
              searchResults.map((session) => (
                <button
                  key={session.id}
                  className={`sidebar-search-result ${session.id === currentSession ? 'active' : ''}`}
                  type="button"
                  role="option"
                  aria-selected={session.id === currentSession}
                  onClick={() => onOpenSession(session)}
                >
                  <span>{session.title}</span>
                  <small>{formatRelativeSessionTime(session.lastMessageAt || session.createdAt, now)}</small>
                </button>
              ))
            ) : (
              <div className="sidebar-feature-empty">没有找到匹配的会话</div>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}
