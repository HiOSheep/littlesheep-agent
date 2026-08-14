// Workspace tab strip: feature tabs, file tabs, and persistent browser tabs.
import { useLayoutEffect, useRef } from 'react'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { CloseMiniIcon, FileGlyphIcon, WorkspaceFeatureIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import {
  isWorkspacePanelTab,
  parseWorkspaceFileTabId,
  type WorkspaceFileDraftState,
  type WorkspacePanelTab,
  type WorkspacePanelTabId,
} from '../workspace-persistence'
import { WorkspaceAddMenu } from './add-menu'
import { isWorkspaceBrowserTabId, type WorkspaceBrowserTab, type WorkspaceBrowserTabId } from './browser-tabs'
import { lastPathSegment } from './path-utils'
import { resolveWorkspaceTabLabelMotion } from './tab-label-motion'

type WorkspaceEntry = { id: WorkspacePanelTab; label: string; desc: string }

export function WorkspaceTabStrip({
  activeTab,
  openTabs,
  browserTabs,
  fileDrafts,
  workspaceEntries,
  onTabChange,
  onCloseTab,
  onOpenBrowserTab,
  onTipChange,
}: {
  activeTab: WorkspacePanelTabId
  openTabs: WorkspacePanelTabId[]
  browserTabs: WorkspaceBrowserTab[]
  fileDrafts: Record<string, WorkspaceFileDraftState>
  workspaceEntries: WorkspaceEntry[]
  onTabChange: (tab: WorkspacePanelTabId) => void
  onCloseTab: (tab: WorkspacePanelTabId) => void
  onOpenBrowserTab: (url: string) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const browserEntry = (tabId: WorkspaceBrowserTabId) => {
    const tab = browserTabs.find((item) => item.id === tabId)
    return {
      id: tabId,
      label: tab?.title || '浏览器',
      desc: tab?.url || '新建浏览器标签',
      kind: 'browser' as const,
      dirty: false,
    }
  }
  const workspaceEntryById = new Map(workspaceEntries.map((entry) => [entry.id, entry]))
  const visibleTabs = openTabs
    .map((tab) => {
      const fileTab = parseWorkspaceFileTabId(tab)
      if (fileTab) {
        return {
          id: tab,
          label: lastPathSegment(fileTab.path),
          desc: fileTab.path,
          kind: 'file' as const,
          dirty: Boolean(fileDrafts[tab]?.editorText !== fileDrafts[tab]?.savedText),
        }
      }
      if (isWorkspaceBrowserTabId(tab)) return browserEntry(tab)
      const entry = isWorkspacePanelTab(tab) ? workspaceEntryById.get(tab) : undefined
      return entry ? { ...entry, kind: 'feature' as const, dirty: false } : null
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
  const displayedTabs = visibleTabs

  return (
    <div className="workspace-tab-strip" role="tablist" aria-label="拓展功能区">
      {displayedTabs.map((entry) => {
        const active = entry.id === activeTab
        return (
          <div
            key={entry.id}
            className={`workspace-active-item ${active ? 'active' : ''} ${entry.kind === 'file' && entry.dirty ? 'file-dirty' : ''}`}
            role="tab"
            tabIndex={0}
            aria-selected={active}
            onClick={() => onTabChange(entry.id)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              onTabChange(entry.id)
            }}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(entry.desc, event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip(entry.desc, event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(entry.desc, event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            {entry.kind === 'file'
              ? <FileGlyphIcon />
              : <WorkspaceFeatureIcon id={entry.kind === 'browser' ? 'browser' : entry.id} />}
            <WorkspaceTabLabel label={entry.label} />
            <button
              {...transientTriggerProps()}
              className="workspace-active-close"
              type="button"
              aria-label={`关闭${entry.label}标签`}
              onClick={(event) => {
                event.stopPropagation()
                onCloseTab(entry.id)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                event.stopPropagation()
                onCloseTab(entry.id)
              }}
            >
              <CloseMiniIcon />
            </button>
          </div>
        )
      })}
      <WorkspaceAddMenu
        entries={workspaceEntries}
        activeTab={isWorkspacePanelTab(activeTab) && displayedTabs.some((entry) => entry.id === activeTab) ? activeTab : null}
        openTabs={displayedTabs.map((entry) => entry.id).filter(isWorkspacePanelTab)}
        onSelect={onTabChange}
        onOpenBrowserTab={onOpenBrowserTab}
        onTipChange={onTipChange}
      />
    </div>
  )
}

function WorkspaceTabLabel({ label }: { label: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    let active = true
    const viewport = viewportRef.current
    const text = textRef.current
    if (!viewport || !text) return

    const updateMotion = () => {
      if (!active) return
      const motion = resolveWorkspaceTabLabelMotion(viewport.clientWidth, text.scrollWidth)
      viewport.classList.toggle('is-overflowing', motion.overflowPx > 0)
      viewport.style.setProperty('--workspace-tab-label-offset', `${motion.offsetPx}px`)
      viewport.style.setProperty('--workspace-tab-label-scroll-duration', `${motion.durationMs}ms`)
    }

    const frame = window.requestAnimationFrame(updateMotion)
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateMotion)
    observer?.observe(viewport)
    observer?.observe(text)
    window.addEventListener('resize', updateMotion)
    void document.fonts?.ready.then(updateMotion)

    return () => {
      active = false
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', updateMotion)
    }
  }, [label])

  return (
    <span ref={viewportRef} className="workspace-active-label">
      <span ref={textRef} className="workspace-active-label-text">{label}</span>
    </span>
  )
}
