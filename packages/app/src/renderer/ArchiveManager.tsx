import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
  deleteArchivedProject,
  deleteArchivedSession,
  listArchive,
  restoreArchivedProject,
  restoreArchivedSession,
  type ArchivedProjectMeta,
  type ArchivedSessionMeta,
  type ArchivePayload,
} from './api'
import { sessionBelongsToProject as sessionHasProject } from '../shared/session-scope'

interface ArchiveManagerProps {
  onChanged?: () => void | Promise<void>
}

const EMPTY_ARCHIVE: ArchivePayload = { projects: [], sessions: [] }

export function ArchiveManager({ onChanged }: ArchiveManagerProps) {
  const [archive, setArchive] = useState<ArchivePayload>(EMPTY_ARCHIVE)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const requestRef = useRef(0)

  useEffect(() => {
    void refreshArchive()
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestRef.current += 1
    }
  }, [])

  const grouped = useMemo(() => groupArchive(archive), [archive])
  const hasItems = archive.projects.length > 0 || archive.sessions.length > 0

  async function refreshArchive() {
    const requestId = ++requestRef.current
    setLoading(true)
    setError(null)
    try {
      const next = await listArchive()
      if (!mountedRef.current || requestId !== requestRef.current) return
      setArchive(next)
    } catch (err) {
      if (!mountedRef.current || requestId !== requestRef.current) return
      setError((err as Error).message)
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false)
    }
  }

  async function runArchiveAction(key: string, action: () => Promise<void>) {
    setBusyKey(key)
    setError(null)
    try {
      await action()
      const next = await listArchive()
      if (!mountedRef.current) return
      setArchive(next)
      await onChanged?.()
    } catch (err) {
      if (!mountedRef.current) return
      setError((err as Error).message)
    } finally {
      if (mountedRef.current) setBusyKey(null)
    }
  }

  function toggleProject(id: string) {
    setExpandedProjects((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="archive-page">
      <div className="archive-heading">
        <span>
          <h2>归档</h2>
          <p>归档会从侧边栏收起项目和对话；恢复或永久删除都在这里处理。</p>
        </span>
        <button className="archive-refresh" type="button" disabled={loading} onClick={() => void refreshArchive()}>
          刷新
        </button>
      </div>

      {error && <div className="archive-error">{error}</div>}

      <section className="archive-section" aria-label="归档项目">
        <div className="archive-section-title">
          <strong>项目</strong>
          <span>{archive.projects.length} 项</span>
        </div>
        <div className="archive-list">
          {loading && <ArchiveSkeleton />}
          {!loading && archive.projects.length === 0 && <ArchiveEmpty text="暂无归档项目" />}
          {!loading && grouped.projects.map(({ project, sessions }) => {
            const expanded = expandedProjects.has(project.id)
            return (
              <div key={project.id} className={`archive-project-group ${expanded ? 'expanded' : 'collapsed'}`}>
                <div className="archive-row archive-project-row">
                  <button
                    className="archive-row-main"
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => toggleProject(project.id)}
                  >
                    <span className="archive-row-arrow" aria-hidden="true" />
                    <ProjectGlyph />
                    <span className="archive-row-text">
                      <strong>{project.name || lastPathSegment(project.path)}</strong>
                      <small>{compactPath(project.path)}</small>
                    </span>
                  </button>
                  <span className="archive-row-time">{formatArchiveTime(project.archivedAt)}</span>
                  <span className="archive-row-actions">
                    <ArchiveActionButton
                      label="恢复项目"
                      disabled={busyKey !== null}
                      active={busyKey === `project:restore:${project.id}`}
                      onClick={() => runArchiveAction(`project:restore:${project.id}`, () => restoreArchivedProject(project.id).then())}
                    >
                      <RestoreGlyph />
                    </ArchiveActionButton>
                    <ArchiveActionButton
                      label="永久删除项目记录"
                      tone="danger"
                      disabled={busyKey !== null}
                      active={busyKey === `project:delete:${project.id}`}
                      onClick={() => runArchiveAction(`project:delete:${project.id}`, () => deleteArchivedProject(project.id))}
                    >
                      <TrashGlyph />
                    </ArchiveActionButton>
                  </span>
                </div>
                <div className="archive-child-list" aria-hidden={!expanded}>
                  {sessions.length > 0 ? (
                    sessions.map((session) => (
                      <ArchiveSessionRow
                        key={session.id}
                        session={session}
                        busyKey={busyKey}
                        indent
                        onRestore={() => runArchiveAction(`session:restore:${session.id}`, () => restoreArchivedSession(session.id).then())}
                        onDelete={() => runArchiveAction(`session:delete:${session.id}`, () => deleteArchivedSession(session.id))}
                      />
                    ))
                  ) : (
                    <div className="archive-empty-row">这个项目下暂无归档对话</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="archive-section" aria-label="归档对话">
        <div className="archive-section-title">
          <strong>对话</strong>
          <span>{grouped.standaloneSessions.length} 项</span>
        </div>
        <div className="archive-list">
          {loading && <ArchiveSkeleton />}
          {!loading && grouped.standaloneSessions.length === 0 && <ArchiveEmpty text="暂无单独归档的对话" />}
          {!loading && grouped.standaloneSessions.map((session) => (
            <ArchiveSessionRow
              key={session.id}
              session={session}
              busyKey={busyKey}
              onRestore={() => runArchiveAction(`session:restore:${session.id}`, () => restoreArchivedSession(session.id).then())}
              onDelete={() => runArchiveAction(`session:delete:${session.id}`, () => deleteArchivedSession(session.id))}
            />
          ))}
        </div>
      </section>

      {!loading && !hasItems && (
        <div className="archive-empty-state">
          <strong>侧边栏已经很干净</strong>
          <span>归档项目或对话后，它们会出现在这里。</span>
        </div>
      )}
    </div>
  )
}

function ArchiveSessionRow({
  session,
  busyKey,
  indent = false,
  onRestore,
  onDelete,
}: {
  session: ArchivedSessionMeta
  busyKey: string | null
  indent?: boolean
  onRestore: () => void | Promise<void>
  onDelete: () => void | Promise<void>
}) {
  return (
    <div className={`archive-row archive-session-row ${indent ? 'indent' : ''}`}>
      <span className="archive-row-main static">
        <ConversationGlyph />
        <span className="archive-row-text">
          <strong>{session.title}</strong>
          <small>{session.workspacePath ? compactPath(session.workspacePath) : session.mode}</small>
        </span>
      </span>
      <span className="archive-row-time">{formatArchiveTime(session.archivedAt)}</span>
      <span className="archive-row-actions">
        <ArchiveActionButton
          label="恢复对话"
          disabled={busyKey !== null}
          active={busyKey === `session:restore:${session.id}`}
          onClick={onRestore}
        >
          <RestoreGlyph />
        </ArchiveActionButton>
        <ArchiveActionButton
          label="永久删除对话"
          tone="danger"
          disabled={busyKey !== null}
          active={busyKey === `session:delete:${session.id}`}
          onClick={onDelete}
        >
          <TrashGlyph />
        </ArchiveActionButton>
      </span>
    </div>
  )
}

function ArchiveActionButton({
  label,
  tone,
  active,
  disabled,
  children,
  onClick,
}: {
  label: string
  tone?: 'danger'
  active?: boolean
  disabled?: boolean
  children: ReactNode
  onClick: () => void | Promise<void>
}) {
  return (
    <button
      className={`archive-action ${tone === 'danger' ? 'danger' : ''} ${active ? 'active' : ''}`}
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        void Promise.resolve(onClick())
      }}
    >
      {children}
    </button>
  )
}

function ArchiveSkeleton() {
  return (
    <>
      <div className="archive-skeleton-row" />
      <div className="archive-skeleton-row short" />
    </>
  )
}

function ArchiveEmpty({ text }: { text: string }) {
  return <div className="archive-empty-row">{text}</div>
}

function groupArchive(archive: ArchivePayload): {
  projects: Array<{ project: ArchivedProjectMeta; sessions: ArchivedSessionMeta[] }>
  standaloneSessions: ArchivedSessionMeta[]
} {
  const usedSessionIds = new Set<string>()
  const projects = archive.projects.map((project) => {
    const sessions = archive.sessions.filter((session) => sessionBelongsToProject(session, project))
    for (const session of sessions) usedSessionIds.add(session.id)
    return { project, sessions }
  })
  return {
    projects,
    standaloneSessions: archive.sessions.filter((session) => !usedSessionIds.has(session.id)),
  }
}

function sessionBelongsToProject(session: ArchivedSessionMeta, project: ArchivedProjectMeta): boolean {
  return sessionHasProject(session, project.id)
}

function formatArchiveTime(timestamp: number): string {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function compactPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return path
  return `${parts[0]}\\...\\${parts.at(-1) ?? ''}`
}

function lastPathSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

function ProjectGlyph() {
  return (
    <svg className="archive-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.6 4.4h4l1.1 1.35h5.7v6.65H2.6z" />
      <path d="M2.6 4.4v-1h3.55l1.05 1" />
    </svg>
  )
}

function ConversationGlyph() {
  return (
    <svg className="archive-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.1 3.5h9.8v6.7H6.3l-3.2 2.3z" />
    </svg>
  )
}

function RestoreGlyph() {
  return (
    <svg className="archive-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5.4 5.1H3.2V2.9" />
      <path d="M3.35 5.05A5.15 5.15 0 1 1 4.9 11.8" />
    </svg>
  )
}

function TrashGlyph() {
  return (
    <svg className="archive-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.4 4.45h9.2M6.35 4.45V3.1h3.3v1.35M4.65 4.45l.55 8.15h5.6l.55-8.15M6.8 6.8v3.65M9.2 6.8v3.65" />
    </svg>
  )
}
