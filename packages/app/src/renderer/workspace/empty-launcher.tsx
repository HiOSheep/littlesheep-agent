// Empty workspace launcher: maps available workspace surfaces to their entry actions.
import { WorkspaceTerminalShellPicker } from './terminal-shell-picker'
import { useTerminalShellSelection } from './use-terminal-shell-selection'
import { WorkspaceFeatureIcon } from '../ui/icons'
import { buildFloatingHelpTip, type FloatingHelpTip } from '../ui/floating-help'
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
  const shells = useTerminalShellSelection()
  function openTerminal(id: string) {
    shells.choose(id)
    onTipChange(null)
    onSelect('terminal')
  }
  return <nav className="workspace-empty-launcher content-fade" aria-label="拓展功能入口">
    {['artifacts', 'review', 'terminal', 'browser'].map((id) => {
      if (id === 'terminal') return <div key={id} className="workspace-empty-launcher-item workspace-start-terminal-entry">
        <span className="workspace-empty-launcher-icon" aria-hidden="true"><WorkspaceFeatureIcon id="terminal" /></span>
        <button className="workspace-start-terminal-open workspace-empty-launcher-body" type="button" disabled={!shells.shellId}
          onClick={() => { if (shells.shellId) openTerminal(shells.shellId) }}>
          <span className="workspace-empty-launcher-label">新建终端</span>
          <span className="workspace-empty-launcher-desc">在工作区运行命令</span>
        </button>
        <div className="workspace-start-shells">
          <WorkspaceTerminalShellPicker profiles={shells.profiles} selectedId={shells.shellId} busy={false}
            onSelect={openTerminal}
            onTipChange={(tip) => onTipChange(tip ? buildFloatingHelpTip(tip.label, tip.x, tip.y) : null)} />
        </div>
      </div>
      const entry = entries.find((entry) => entry.id === id)
      if (!entry) return null
      return <button {...transientTriggerProps()} key={entry.id} className="workspace-empty-launcher-item" type="button" onClick={() => {
        onTipChange(null)
        const selection = resolveWorkspaceEntrySelection(entry.id)
        if (selection.kind === 'new-browser-tab') onOpenBrowserTab(selection.url)
        else onSelect(selection.tab)
      }}>
        <span className="workspace-empty-launcher-icon" aria-hidden="true"><WorkspaceFeatureIcon id={entry.id} /></span>
        <span className="workspace-empty-launcher-body">
          <span className="workspace-empty-launcher-label">{id === 'artifacts' ? '工作区文件' : id === 'review' ? '审阅' : '浏览器'}</span>
          <span className="workspace-empty-launcher-desc">{id === 'artifacts' ? '浏览工作区文件' : id === 'review' ? '查看当前 Git 更改' : '浏览网页'}</span>
        </span>
      </button>
    })}
  </nav>
}
