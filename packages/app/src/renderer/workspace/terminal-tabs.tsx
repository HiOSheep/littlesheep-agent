// UX-30: the terminal tab strip.
//
// Each tab names the shell it is really running and its state, so "which terminal is that?"
// is answerable without clicking through them; a session that has exited says so instead of
// looking alive.
import type { FloatingHelpTip } from '../ui/floating-help'
import { buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { transientTriggerProps } from '../ui/transient'
import { CloseIcon } from '../ui/icons'
import {
  terminalTabStatusLabel,
  type TerminalSessionTab,
} from './terminal-sessions'

export function WorkspaceTerminalTabs({
  tabs,
  activeId,
  busy,
  onSelect,
  onClose,
  onNew,
  onTipChange,
}: {
  tabs: readonly TerminalSessionTab[]
  activeId: string | null
  busy: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  return (
    <div className="workspace-terminal-tabs" role="tablist" aria-label="终端会话">
      {tabs.map((tab, index) => {
        const label = `${tab.shellLabel}（${terminalTabStatusLabel(tab)}）`
        const tip = `${label}\n${tab.cwd}`
        return (
          <div
            key={tab.id}
            className={`workspace-terminal-tab ${tab.id === activeId ? 'active' : ''} ${tab.status}`}
            role="tab"
            aria-selected={tab.id === activeId}
            aria-label={label}
          >
            <button
              {...transientTriggerProps()}
              className="workspace-terminal-tab-select"
              type="button"
              onClick={() => onSelect(tab.id)}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(tip, event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              <span className="workspace-terminal-tab-title">{`终端 ${index + 1}`}</span>
              <span className="workspace-terminal-tab-shell">{terminalTabStatusLabel(tab)}</span>
            </button>
            <button
              {...transientTriggerProps()}
              className="workspace-terminal-tab-close"
              type="button"
              aria-label={`关闭终端 ${index + 1}`}
              onClick={() => onClose(tab.id)}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('关闭这个终端会话', event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('关闭这个终端会话', event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              <CloseIcon />
            </button>
          </div>
        )
      })}
      <button
        {...transientTriggerProps()}
        className="workspace-files-text-btn workspace-terminal-tab-new"
        type="button"
        disabled={busy}
        onClick={onNew}
        onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('新建一个终端会话（不影响正在运行的那些）', event.clientX, event.clientY))}
        onMouseLeave={() => onTipChange(null)}
        onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('新建一个终端会话（不影响正在运行的那些）', event.currentTarget))}
        onBlur={() => onTipChange(null)}
      >
        新建
      </button>
    </div>
  )
}
