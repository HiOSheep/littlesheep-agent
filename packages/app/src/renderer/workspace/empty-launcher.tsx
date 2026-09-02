// Empty workspace launcher: maps available workspace surfaces to their entry actions.
import { WorkspaceFeatureIcon } from '../ui/icons'
import { buildFloatingHelpTip, buildFloatingHelpTipFromElement, type FloatingHelpTip } from '../ui/floating-help'
import { transientTriggerProps } from '../ui/transient'
import type { WorkspacePanelTab } from '../workspace-persistence'
import { resolveWorkspaceEntrySelection } from './entry-selection'

export function WorkspaceEmptyLauncher({
  entries, onSelect, onOpenBrowserTab, onTipChange,
}: {
  entries: Array<{ id: WorkspacePanelTab; label: string; desc: string }>
  onSelect: (tab: WorkspacePanelTab) => void
  onOpenBrowserTab: (url: string) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  return <nav className="workspace-empty-launcher content-fade" aria-label="拓展功能入口">
    {entries.map((entry) => <button {...transientTriggerProps()} key={entry.id} className="workspace-empty-launcher-item" type="button" onClick={() => {
      onTipChange(null)
      const selection = resolveWorkspaceEntrySelection(entry.id)
      if (selection.kind === 'new-browser-tab') onOpenBrowserTab(selection.url)
      else onSelect(selection.tab)
    }} onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(entry.desc, event.clientX, event.clientY))} onMouseMove={(event) => onTipChange(buildFloatingHelpTip(entry.desc, event.clientX, event.clientY))} onMouseLeave={() => onTipChange(null)} onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(entry.desc, event.currentTarget))} onBlur={() => onTipChange(null)}>
      <span className="workspace-empty-launcher-icon" aria-hidden="true"><WorkspaceFeatureIcon id={entry.id} /></span>
      <span className="workspace-empty-launcher-label">{entry.label}</span>
    </button>)}
  </nav>
}
