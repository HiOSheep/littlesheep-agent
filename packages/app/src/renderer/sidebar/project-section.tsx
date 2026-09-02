// Primary navigation, project/session trees, and sidebar actions.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { APPLICATION_PERSISTENCE_FLUSH_EVENT } from '../../shared/application-state-contracts'
import { projectSessions } from '../../shared/session-scope'
import {
  type ProjectMeta,
  type SessionMeta,
} from '../api'
import { formatRelativeSessionTime, mergeOrderedList, sortProjectsForSidebar } from '../app-shell/list-motion'
import {
  EXPANDED_PROJECT_IDS_KEY,
  PROJECT_SECTION_COLLAPSED_KEY,
  PROJECT_SORT_KEY,
  SIDEBAR_PROJECT_ORDER_KEY,
  readBooleanPreference,
  readProjectSortPreference,
  readStringListPreference,
  readStringSetPreference,
  writeBooleanPreference,
  writeStringListPreference,
  writeStringPreference,
  writeStringSetPreference,
} from '../app-shell/preferences'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { ArchiveIcon, CheckIcon, ComposeIcon, MoreIcon, ProjectIcon, SortIcon, TrashIcon } from '../ui/icons'
import { OverflowingLabel } from '../ui/overflowing-label'
import { isSamePath, lastPathSegment } from '../workspace/path-utils'
import { SidebarActionMenu } from './action-menu'
import { useSidebarListDrag } from './list-drag'
import { SessionRow } from './session-row'
import { ProjectSortMode } from './types'


export function SidebarProjectSection({
  projects,
  sessions,
  currentSession,
  pinnedSessionIds,
  now,
  activeProjectId,
  fallbackPath,
  onOpenProject,
  onCreateProjectConversation,
  onOpenWorkspace,
  onOpenSession,
  onTogglePin,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
  onArchiveProject,
  onRebindProject,
  onDeleteProject,
  onReorderSessions,
  onTipChange,
}: {
  projects: ProjectMeta[]
  sessions: SessionMeta[]
  currentSession?: string
  pinnedSessionIds: Set<string>
  now: number
  activeProjectId?: string
  fallbackPath: string
  onOpenProject: (project: ProjectMeta) => void
  onCreateProjectConversation: (project: ProjectMeta) => void
  onOpenWorkspace: () => void
  onOpenSession: (session: SessionMeta) => void
  onTogglePin: (id: string) => void
  onRenameSession: (id: string, title: string) => void | Promise<void>
  onArchiveSession: (id: string) => void | Promise<void>
  onDeleteSession: (id: string) => void | Promise<void>
  onArchiveProject: (project: ProjectMeta) => void | Promise<void>
  onRebindProject: (project: ProjectMeta) => void | Promise<void>
  onDeleteProject: (project: ProjectMeta) => void | Promise<void>
  onReorderSessions: (sessionIds: string[]) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [collapsed, setCollapsed] = useState(() => readBooleanPreference(PROJECT_SECTION_COLLAPSED_KEY, false))
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => (
    readStringSetPreference(EXPANDED_PROJECT_IDS_KEY)
  ))
  const [sortMode, setSortMode] = useState<ProjectSortMode>(() => readProjectSortPreference(PROJECT_SORT_KEY))
  const [projectOrder, setProjectOrder] = useState(() => readStringListPreference(SIDEBAR_PROJECT_ORDER_KEY))
  const durableProjectSectionRef = useRef({ collapsed, expandedProjectIds, sortMode, projectOrder })
  const projectTreeRef = useRef<HTMLDivElement>(null)
  durableProjectSectionRef.current = { collapsed, expandedProjectIds, sortMode, projectOrder }
  const baseProjects = useMemo(
    () => projects.filter((project) => !isSamePath(project.path, fallbackPath)),
    [fallbackPath, projects],
  )
  const visibleProjects = useMemo(
    () => sortProjectsForSidebar(baseProjects, sortMode, projectOrder),
    [baseProjects, projectOrder, sortMode],
  )
  const projectsById = useMemo(
    () => new Map(visibleProjects.map((project) => [project.id, project])),
    [visibleProjects],
  )
  const projectDrag = useSidebarListDrag(
    visibleProjects.map((project) => project.id),
    {
      scrollContainerRef: projectTreeRef,
      onReorder: (projectIds) => {
        setProjectOrder((current) => mergeOrderedList(projectIds, current))
        setSortMode('fixed')
      },
      onDragStart: () => onTipChange(null),
    },
  )
  const displayedProjects = projectDrag.orderedIds
    .map((id) => projectsById.get(id))
    .filter((project): project is ProjectMeta => Boolean(project))
  const activeProject = visibleProjects.find((project) => project.id === activeProjectId)

  useEffect(() => {
    writeStringPreference(PROJECT_SORT_KEY, sortMode)
  }, [sortMode])

  useEffect(() => {
    writeBooleanPreference(PROJECT_SECTION_COLLAPSED_KEY, collapsed)
  }, [collapsed])

  useEffect(() => {
    writeStringSetPreference(EXPANDED_PROJECT_IDS_KEY, expandedProjectIds)
  }, [expandedProjectIds])

  useEffect(() => {
    writeStringListPreference(SIDEBAR_PROJECT_ORDER_KEY, projectOrder)
  }, [projectOrder])

  useEffect(() => {
    const flushProjectSectionPreferences = () => {
      const state = durableProjectSectionRef.current
      writeBooleanPreference(PROJECT_SECTION_COLLAPSED_KEY, state.collapsed)
      writeStringSetPreference(EXPANDED_PROJECT_IDS_KEY, state.expandedProjectIds)
      writeStringPreference(PROJECT_SORT_KEY, state.sortMode)
      writeStringListPreference(SIDEBAR_PROJECT_ORDER_KEY, state.projectOrder)
    }
    window.addEventListener(APPLICATION_PERSISTENCE_FLUSH_EVENT, flushProjectSectionPreferences)
    return () => window.removeEventListener(APPLICATION_PERSISTENCE_FLUSH_EVENT, flushProjectSectionPreferences)
  }, [])

  useEffect(() => {
    if (!activeProject) return
    setExpandedProjectIds((ids) => {
      if (ids.has(activeProject.id)) return ids
      const next = new Set(ids)
      next.add(activeProject.id)
      return next
    })
  }, [activeProject?.id])

  function toggleProject(project: ProjectMeta, active: boolean) {
    setExpandedProjectIds((ids) => {
      const next = new Set(ids)
      if (active && next.has(project.id)) {
        next.delete(project.id)
      } else {
        next.add(project.id)
      }
      return next
    })
    if (!active) onOpenProject(project)
  }

  return (
    <section className={`sidebar-section project-section ${collapsed ? 'collapsed' : ''}`} aria-label="项目">
      <div className="sidebar-section-header">
        <button
          className="sidebar-section-toggle"
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span>项目</span>
          <span className="sidebar-section-arrow" aria-hidden="true" />
        </button>
        <div className="sidebar-section-actions" aria-hidden={collapsed ? undefined : false}>
          <SidebarActionMenu
            label="项目菜单"
            onTipChange={onTipChange}
            items={[
              {
                label: '保持原位置',
                icon: sortMode === 'fixed' ? <CheckIcon /> : <SortIcon />,
                onSelect: () => setSortMode('fixed'),
              },
              {
                label: '按最近使用',
                icon: sortMode === 'recent' ? <CheckIcon /> : <SortIcon />,
                onSelect: () => setSortMode('recent'),
              },
              {
                label: '按项目名称',
                icon: sortMode === 'name' ? <CheckIcon /> : <SortIcon />,
                onSelect: () => setSortMode('name'),
              },
              {
                label: '归档所有项目',
                icon: <ArchiveIcon />,
                onSelect: async () => {
                  for (const project of visibleProjects) await onArchiveProject(project)
                },
              },
            ]}
          >
            <MoreIcon />
          </SidebarActionMenu>
          <button
            className="sidebar-section-action sidebar-new-action"
            type="button"
            aria-label="添加项目"
            onClick={onOpenWorkspace}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('添加项目', event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip('添加项目', event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('添加项目', event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            <ComposeIcon />
          </button>
        </div>
      </div>
      <div
        ref={projectTreeRef}
        className="project-tree"
        aria-hidden={collapsed}
        {...(collapsed ? { inert: '' } : {})}
      >
        {displayedProjects.map((project) => (
          <SidebarProjectGroup
            key={project.id}
            project={project}
            sessions={sessionsForSidebarProject(sessions, project)}
            currentSession={currentSession}
            pinnedSessionIds={pinnedSessionIds}
            now={now}
            active={project.id === activeProjectId}
            expanded={expandedProjectIds.has(project.id)}
            projectTreeRef={projectTreeRef}
            dragging={projectDrag.draggingId === project.id}
            projectItemRef={projectDrag.itemRef(project.id)}
            onProjectPointerDown={projectDrag.onPointerDown(project.id)}
            onProjectClickCapture={projectDrag.onClickCapture}
            onToggleProject={() => toggleProject(project, project.id === activeProjectId)}
            onCreateConversation={() => onCreateProjectConversation(project)}
            onOpenSession={onOpenSession}
            onTogglePin={onTogglePin}
            onRenameSession={onRenameSession}
            onArchiveSession={onArchiveSession}
            onDeleteSession={onDeleteSession}
            onArchiveProject={() => onArchiveProject(project)}
            onRebindProject={() => onRebindProject(project)}
            onDeleteProject={() => onDeleteProject(project)}
            onReorderSessions={onReorderSessions}
            onTipChange={onTipChange}
          />
        ))}
      </div>
    </section>
  )
}


interface SidebarProjectGroupProps {
  project: ProjectMeta
  sessions: SessionMeta[]
  currentSession?: string
  pinnedSessionIds: Set<string>
  now: number
  active: boolean
  expanded: boolean
  projectTreeRef: RefObject<HTMLDivElement | null>
  dragging: boolean
  projectItemRef: (node: HTMLDivElement | null) => void
  onProjectPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onProjectClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => void
  onToggleProject: () => void
  onCreateConversation: () => void
  onOpenSession: (session: SessionMeta) => void
  onTogglePin: (id: string) => void
  onRenameSession: (id: string, title: string) => void | Promise<void>
  onArchiveSession: (id: string) => void | Promise<void>
  onDeleteSession: (id: string) => void | Promise<void>
  onArchiveProject: () => void | Promise<void>
  onRebindProject: () => void | Promise<void>
  onDeleteProject: () => void | Promise<void>
  onReorderSessions: (sessionIds: string[]) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}


function SidebarProjectGroup({
  project,
  sessions,
  currentSession,
  pinnedSessionIds,
  now,
  active,
  expanded,
  projectTreeRef,
  dragging,
  projectItemRef,
  onProjectPointerDown,
  onProjectClickCapture,
  onToggleProject,
  onCreateConversation,
  onOpenSession,
  onTogglePin,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
  onArchiveProject,
  onRebindProject,
  onDeleteProject,
  onReorderSessions,
  onTipChange,
}: SidebarProjectGroupProps) {
  const tip = `项目工作区\n${project.path}`
  const lastActiveAt = Date.parse(project.lastActiveAt)
  const newSessionTip = '在项目下新建对话'
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  )
  const pinnedSessions = sessions.filter((session) => pinnedSessionIds.has(session.id))
  const unpinnedSessions = sessions.filter((session) => !pinnedSessionIds.has(session.id))
  const pinnedDrag = useSidebarListDrag(
    pinnedSessions.map((session) => session.id),
    {
      scrollContainerRef: projectTreeRef,
      onReorder: onReorderSessions,
      onDragStart: () => onTipChange(null),
    },
  )
  const unpinnedDrag = useSidebarListDrag(
    unpinnedSessions.map((session) => session.id),
    {
      scrollContainerRef: projectTreeRef,
      onReorder: onReorderSessions,
      onDragStart: () => onTipChange(null),
    },
  )
  const displayedSessions = [
    ...pinnedDrag.orderedIds,
    ...unpinnedDrag.orderedIds,
  ].map((id) => sessionsById.get(id)).filter((session): session is SessionMeta => Boolean(session))

  return (
    <div
      ref={projectItemRef}
      className={`project-group ${expanded ? 'expanded' : 'collapsed'} ${dragging ? 'is-dragging' : ''}`}
    >
      <div
        className={`session-item project-item ${active ? 'active' : ''} ${expanded ? 'expanded' : ''}`}
        aria-grabbed={dragging || undefined}
        onPointerDown={onProjectPointerDown}
        onClickCapture={onProjectClickCapture}
      >
        <button
          className="project-row-trigger"
          type="button"
          data-sidebar-drag-source
          onClick={onToggleProject}
          aria-label={tip}
          aria-expanded={expanded}
          aria-current={active ? 'page' : undefined}
          onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
          onMouseMove={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(tip, event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          <span className="project-row-arrow" aria-hidden="true" />
          <ProjectIcon />
          <OverflowingLabel
            label={project.name || lastPathSegment(project.path)}
            className="sidebar-overflowing-label project-row-title"
            textClassName="sidebar-overflowing-label-text"
          />
        </button>
        <span className="session-tail" aria-hidden="true">
          <span className="session-time">
            {Number.isFinite(lastActiveAt) ? formatRelativeSessionTime(lastActiveAt, now) : ''}
          </span>
        </span>
        <span className="session-row-actions" aria-label="项目操作">
          <button
            className="sidebar-section-action project-new-session-action"
            type="button"
            aria-label={newSessionTip}
            onClick={(event) => {
              event.stopPropagation()
              onCreateConversation()
            }}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(newSessionTip, event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip(newSessionTip, event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(newSessionTip, event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            <ComposeIcon />
          </button>
          <SidebarActionMenu
            label="项目菜单"
            onTipChange={onTipChange}
            items={[
              {
                label: '重新定位项目',
                icon: <ProjectIcon />,
                onSelect: onRebindProject,
              },
              {
                label: '归档项目',
                icon: <ArchiveIcon />,
                onSelect: onArchiveProject,
              },
              {
                label: '删除项目',
                icon: <TrashIcon />,
                tone: 'danger',
                onSelect: onDeleteProject,
              },
            ]}
          >
            <MoreIcon />
          </SidebarActionMenu>
        </span>
      </div>
      <div
        className="project-session-list"
        aria-hidden={!expanded}
        {...(!expanded ? { inert: '' } : {})}
      >
        {displayedSessions.length > 0 ? (
          displayedSessions.map((session) => {
            const drag = pinnedSessionIds.has(session.id) ? pinnedDrag : unpinnedDrag
            return (
              <SessionRow
                key={session.id}
                session={session}
                active={session.id === currentSession}
                pinned={pinnedSessionIds.has(session.id)}
                now={now}
                className="project-session-item"
                itemRef={drag.itemRef(session.id)}
                dragging={drag.draggingId === session.id}
                onDragPointerDown={drag.onPointerDown(session.id)}
                onDragClickCapture={drag.onClickCapture}
                onOpen={() => onOpenSession(session)}
                onTogglePin={() => onTogglePin(session.id)}
                onRename={(title) => onRenameSession(session.id, title)}
                onArchive={() => onArchiveSession(session.id)}
                onDelete={() => onDeleteSession(session.id)}
                onTipChange={onTipChange}
              />
            )
          })
        ) : (
          <div className="project-session-empty">暂无对话</div>
        )}
      </div>
    </div>
  )
}


export function sessionsForSidebarProject(
  sessions: SessionMeta[],
  project: ProjectMeta,
): SessionMeta[] {
  return projectSessions(sessions, project.id)
}
