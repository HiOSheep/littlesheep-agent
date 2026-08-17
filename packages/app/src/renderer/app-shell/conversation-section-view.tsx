// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import { SidebarActionMenu } from '../sidebar/action-menu'
import { SessionRow } from '../sidebar/session-row'
import { buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { ArchiveIcon, ComposeIcon, MoreIcon } from '../ui/icons'
import type { ConversationSectionViewController } from './app-controller-projections'




export function ConversationSectionView({ controller }: { controller: ConversationSectionViewController }) {
  const {
    conversationCollapsed,
    setConversationCollapsed,
    moreConversationTip,
    setControlTip,
    archiveAllSessions,
    newConversationTip,
    createConversationFromSidebar,
    visibleSessions,
    currentSession,
    pinnedSessionIds,
    now,
    visibleSessionMotionRef,
    switchSession,
    togglePinnedSession,
    renameSession,
    archiveSession,
    deleteSessionPermanently,
  } = controller
  return (
        <section
          className={`sidebar-section conversation-section ${conversationCollapsed ? 'collapsed' : ''}`}
          aria-label="对话"
        >
          <div className="sidebar-section-header">
            <button
              className="sidebar-section-toggle"
              type="button"
              aria-expanded={!conversationCollapsed}
              onClick={() => setConversationCollapsed((value) => !value)}
            >
              <span>对话</span>
              <span className="sidebar-section-arrow" aria-hidden="true" />
            </button>
            <div className="sidebar-section-actions" aria-hidden={conversationCollapsed ? undefined : false}>
              <SidebarActionMenu
                label={moreConversationTip}
                onTipChange={setControlTip}
                items={[
                  {
                    label: '归档所有对话',
                    icon: <ArchiveIcon />,
                    onSelect: archiveAllSessions,
                  },
                ]}
              >
                <MoreIcon />
              </SidebarActionMenu>
              <button
                className="sidebar-section-action sidebar-new-action"
                type="button"
                aria-label={newConversationTip}
                onClick={createConversationFromSidebar}
                onMouseEnter={(event) => setControlTip(buildFloatingHelpTip(newConversationTip, event.clientX, event.clientY))}
                onMouseMove={(event) => setControlTip(buildFloatingHelpTip(newConversationTip, event.clientX, event.clientY))}
                onMouseLeave={() => setControlTip(null)}
                onFocus={(event) => setControlTip(buildFloatingHelpTipFromElement(newConversationTip, event.currentTarget))}
                onBlur={() => setControlTip(null)}
              >
                <ComposeIcon />
              </button>
            </div>
          </div>
          <div
            className="session-list"
            aria-hidden={conversationCollapsed}
            {...(conversationCollapsed ? { inert: '' } : {})}
          >
            {visibleSessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === currentSession}
                pinned={pinnedSessionIds.has(s.id)}
                now={now}
                itemRef={visibleSessionMotionRef(s.id)}
                onOpen={() => void switchSession(s)}
                onTogglePin={() => togglePinnedSession(s.id)}
                onRename={(title) => renameSession(s.id, title)}
                onArchive={() => archiveSession(s.id)}
                onDelete={() => deleteSessionPermanently(s.id)}
                onTipChange={setControlTip}
              />
            ))}
          </div>
        </section>

  )
}
