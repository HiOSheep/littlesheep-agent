// Primary navigation, project/session trees, and sidebar actions.
import { useEffect,useMemo,useState } from 'react'
import { projectSessions } from '../../shared/session-scope'
import {
type ProjectMeta,
type SessionMeta
} from '../api'
import { formatRelativeSessionTime,sortProjectsForSidebar,useListReorderAnimation } from '../app-shell/list-motion'
import { PROJECT_SORT_KEY,readProjectSortPreference,writeStringPreference } from '../app-shell/preferences'
import { FloatingHelpTip,buildFloatingHelpTip,buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { ArchiveIcon,CheckIcon,ComposeIcon,MoreIcon,ProjectIcon,SortIcon,TrashIcon } from '../ui/icons'
import { isSamePath,lastPathSegment } from '../workspace/path-utils'
import { SidebarActionMenu } from './action-menu'
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
  onOpenWorkspace,
  onOpenSession,
  onTogglePin,
  onArchiveSession,
  onDeleteSession,
  onArchiveProject,
  onRebindProject,
  onDeleteProject,
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
  onOpenWorkspace: () => void
  onOpenSession: (session: SessionMeta) => void
  onTogglePin: (id: string) => void
  onArchiveSession: (id: string) => void | Promise<void>
  onDeleteSession: (id: string) => void | Promise<void>
  onArchiveProject: (project: ProjectMeta) => void | Promise<void>
  onRebindProject: (project: ProjectMeta) => void | Promise<void>
  onDeleteProject: (project: ProjectMeta) => void | Promise<void>
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set())
  const [sortMode, setSortMode] = useState<ProjectSortMode>(() => readProjectSortPreference(PROJECT_SORT_KEY))
  const baseProjects = useMemo(
    () => projects.filter((project) => !isSamePath(project.path, fallbackPath)),
    [fallbackPath, projects],
  )
  const visibleProjects = useMemo(() => sortProjectsForSidebar(baseProjects, sortMode), [baseProjects, sortMode])
  const activeProject = visibleProjects.find((project) => project.id === activeProjectId)
  const projectMotionRef = useListReorderAnimation<HTMLDivElement>(visibleProjects.map((project) => project.id))
  const projectSessionKeys = visibleProjects.flatMap((project) =>
    sessionsForSidebarProject(sessions, project).map((session) => `${project.id}:${session.id}`),
  )
  const projectSessionMotionRef = useListReorderAnimation<HTMLDivElement>(projectSessionKeys)

  useEffect(() => {
    writeStringPreference(PROJECT_SORT_KEY, sortMode)
  }, [sortMode])

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
      <div className="project-tree">
        {visibleProjects.map((project) => {
          const tip = `项目工作区\n${project.path}`
          const active = project.id === activeProjectId
          const expanded = expandedProjectIds.has(project.id)
          const projectSessions = sessionsForSidebarProject(sessions, project)
          const lastActiveAt = Date.parse(project.lastActiveAt)
          return (
            <div
              key={project.id}
              ref={projectMotionRef(project.id)}
              className={`project-group ${expanded ? 'expanded' : 'collapsed'}`}
            >
              <div className={`session-item project-item ${active ? 'active' : ''} ${expanded ? 'expanded' : ''}`}>
                <button
                  className="project-row-trigger"
                  type="button"
                  onClick={() => toggleProject(project, active)}
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
                  <span className="project-row-title">{project.name || lastPathSegment(project.path)}</span>
                </button>
                <span className="session-tail" aria-hidden="true">
                  <span className="session-time">
                    {Number.isFinite(lastActiveAt) ? formatRelativeSessionTime(lastActiveAt, now) : ''}
                  </span>
                </span>
                <span className="session-row-actions" aria-label="项目操作">
                  <SidebarActionMenu
                    label="项目菜单"
                    onTipChange={onTipChange}
                    items={[
                      {
                        label: '重新定位项目',
                        icon: <ProjectIcon />,
                        onSelect: () => onRebindProject(project),
                      },
                      {
                        label: '归档项目',
                        icon: <ArchiveIcon />,
                        onSelect: () => onArchiveProject(project),
                      },
                      {
                        label: '删除项目',
                        icon: <TrashIcon />,
                        tone: 'danger',
                        onSelect: () => onDeleteProject(project),
                      },
                    ]}
                  >
                    <MoreIcon />
                  </SidebarActionMenu>
                </span>
              </div>
              <div className="project-session-list" aria-hidden={!expanded}>
                {projectSessions.length > 0 ? (
                  projectSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      active={session.id === currentSession}
                      pinned={pinnedSessionIds.has(session.id)}
                      now={now}
                      className="project-session-item"
                      itemRef={projectSessionMotionRef(`${project.id}:${session.id}`)}
                      onOpen={() => onOpenSession(session)}
                      onTogglePin={() => onTogglePin(session.id)}
                      onArchive={() => onArchiveSession(session.id)}
                      onDelete={() => onDeleteSession(session.id)}
                      onTipChange={onTipChange}
                    />
                  ))
                ) : (
                  <div className="project-session-empty">暂无对话</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}


export function sessionsForSidebarProject(
  sessions: SessionMeta[],
  project: ProjectMeta,
): SessionMeta[] {
  return projectSessions(sessions, project.id)
}
