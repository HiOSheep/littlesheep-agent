// Primary navigation, project/session trees, and sidebar actions.
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  normalizeSessionTitle,
  SESSION_TITLE_MAX_LENGTH,
} from '../../shared/session-project-contracts'
import {
  type SessionMeta
} from '../api'
import { formatRelativeSessionTime } from '../app-shell/list-motion'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { ArchiveIcon, MoreIcon, PinIcon, RenameIcon, TrashIcon } from '../ui/icons'
import { OverflowingLabel } from '../ui/overflowing-label'
import { SidebarActionMenu } from './action-menu'


export function SessionRow({
  session,
  active,
  pinned,
  now,
  className,
  itemRef,
  dragging = false,
  onDragPointerDown,
  onDragClickCapture,
  onOpen,
  onTogglePin,
  onRename,
  onArchive,
  onDelete,
  onTipChange,
}: {
  session: SessionMeta
  active: boolean
  pinned: boolean
  now: number
  className?: string
  itemRef?: (node: HTMLDivElement | null) => void
  dragging?: boolean
  onDragPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void
  onDragClickCapture?: (event: ReactMouseEvent<HTMLDivElement>) => void
  onOpen: () => void
  onTogglePin: () => void
  onRename: (title: string) => void | Promise<void>
  onArchive: () => void | Promise<void>
  onDelete: () => void | Promise<void>
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const pinLabel = pinned ? '取消置顶' : '置顶对话'
  const menuLabel = '对话菜单'
  const lastActiveAt = session.lastMessageAt || session.createdAt
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState(session.title)
  const [renameSaving, setRenameSaving] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameRequestRef = useRef(0)
  const focusFrameRef = useRef<number>()

  useEffect(() => {
    if (!renaming) return
    focusFrameRef.current = window.requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(focusFrameRef.current ?? 0)
  }, [renaming])

  useEffect(() => () => {
    renameRequestRef.current += 1
    window.cancelAnimationFrame(focusFrameRef.current ?? 0)
  }, [])

  function beginRename() {
    renameRequestRef.current += 1
    setRenameDraft(session.title)
    setRenameSaving(false)
    setRenaming(true)
  }

  function cancelRename() {
    if (renameSaving) return
    renameRequestRef.current += 1
    setRenameDraft(session.title)
    setRenaming(false)
  }

  async function commitRename() {
    if (renameSaving) return
    const title = normalizeSessionTitle(renameDraft)
    if (!title || title === session.title) {
      setRenameDraft(session.title)
      setRenaming(false)
      return
    }
    const requestId = ++renameRequestRef.current
    setRenameSaving(true)
    try {
      await onRename(title)
      if (requestId !== renameRequestRef.current) return
      setRenameDraft(title)
      setRenameSaving(false)
      setRenaming(false)
    } catch {
      if (requestId !== renameRequestRef.current) return
      setRenameSaving(false)
      focusFrameRef.current = window.requestAnimationFrame(() => renameInputRef.current?.focus())
    }
  }

  return (
    <div
      ref={itemRef}
      className={`session-item ${className ?? ''} ${active ? 'active' : ''} ${pinned ? 'pinned' : ''} ${renaming ? 'renaming' : ''} ${dragging ? 'is-dragging' : ''}`}
      role={renaming ? undefined : 'button'}
      tabIndex={renaming ? -1 : 0}
      aria-current={active ? 'page' : undefined}
      aria-grabbed={dragging || undefined}
      onPointerDown={onDragPointerDown}
      onClickCapture={onDragClickCapture}
      onClick={() => {
        if (!renaming) onOpen()
      }}
      onKeyDown={(event) => {
        if (renaming) return
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen()
      }}
    >
      {renaming ? (
        <input
          ref={renameInputRef}
          className="session-rename-input"
          value={renameDraft}
          maxLength={SESSION_TITLE_MAX_LENGTH}
          disabled={renameSaving}
          aria-label={`重命名对话：${session.title}`}
          onChange={(event) => setRenameDraft(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onBlur={() => void commitRename()}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape') {
              event.preventDefault()
              cancelRename()
            } else if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            }
          }}
        />
      ) : (
        <>
          <OverflowingLabel
            label={session.title}
            className="sidebar-overflowing-label session-title"
            textClassName="sidebar-overflowing-label-text"
          />
          <span className="session-tail" aria-hidden="true">
            <span className="session-time">{formatRelativeSessionTime(lastActiveAt, now)}</span>
          </span>
          <span className="session-row-actions" aria-label="对话操作">
            <button
              className={`sidebar-section-action session-pin-action ${pinned ? 'active' : ''}`}
              type="button"
              aria-label={pinLabel}
              aria-pressed={pinned}
              onClick={(event) => {
                event.stopPropagation()
                onTogglePin()
              }}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(pinLabel, event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip(pinLabel, event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(pinLabel, event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              <PinIcon active={pinned} />
            </button>
            <SidebarActionMenu
              label={menuLabel}
              onTipChange={onTipChange}
              items={[
                {
                  label: '重命名',
                  icon: <RenameIcon />,
                  onSelect: beginRename,
                },
                {
                  label: '归档对话',
                  icon: <ArchiveIcon />,
                  onSelect: onArchive,
                },
                {
                  label: '删除对话',
                  icon: <TrashIcon />,
                  tone: 'danger',
                  onSelect: onDelete,
                },
              ]}
            >
              <MoreIcon />
            </SidebarActionMenu>
          </span>
        </>
      )}
    </div>
  )
}
