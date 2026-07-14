// Primary navigation, project/session trees, and sidebar actions.
import {
type SessionMeta
} from '../api'
import { formatRelativeSessionTime } from '../app-shell/list-motion'
import { FloatingHelpTip,buildFloatingHelpTip,buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { ArchiveIcon,MoreIcon,PinIcon,TrashIcon } from '../ui/icons'
import { SidebarActionMenu } from './action-menu'


export function SessionRow({
  session,
  active,
  pinned,
  now,
  className,
  itemRef,
  onOpen,
  onTogglePin,
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
  onOpen: () => void
  onTogglePin: () => void
  onArchive: () => void | Promise<void>
  onDelete: () => void | Promise<void>
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const pinLabel = pinned ? '取消置顶' : '置顶对话'
  const menuLabel = '对话菜单'
  const lastActiveAt = session.lastMessageAt || session.createdAt

  return (
    <div
      ref={itemRef}
      className={`session-item ${className ?? ''} ${active ? 'active' : ''} ${pinned ? 'pinned' : ''}`}
      role="button"
      tabIndex={0}
      aria-current={active ? 'page' : undefined}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen()
      }}
    >
      <span className="session-title">{session.title}</span>
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
    </div>
  )
}
