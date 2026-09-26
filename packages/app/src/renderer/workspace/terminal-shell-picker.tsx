// UX-29: the "new terminal" Shell dropdown.
//
// It shows the real shell names Main discovered, explains the ones that are unavailable
// instead of hiding them, and refuses to guess: every option it can offer is one Main
// validated on this machine.
import type { WorkspaceShellProfile } from '../api/terminal'

export function WorkspaceTerminalShellPicker({
  profiles,
  selectedId,
  busy,
  onSelect,
  onTipChange,
}: {
  profiles: readonly WorkspaceShellProfile[]
  selectedId: string | null
  busy: boolean
  onSelect: (id: string) => void
  onTipChange?: (tip: { label: string; x: number; y: number } | null) => void
}) {
  const available = profiles.filter((profile) => profile.available)
  const missing = profiles.filter((profile) => !profile.available)
  const missingHint = missing
    .map((profile) => `${profile.label}：${profile.reason ?? '不可用'}`)
    .join('\n')

  return (
    <label className="workspace-terminal-shell">
      <span className="workspace-terminal-shell-label">Shell</span>
      <select
        className="workspace-terminal-shell-select"
        aria-label="选择终端 Shell"
        value={selectedId ?? ''}
        disabled={busy || available.length === 0}
        title={missingHint ? `本机缺少：\n${missingHint}` : undefined}
        onChange={(event) => onSelect(event.target.value)}
        onFocus={() => onTipChange?.(null)}
      >
        {available.length === 0 && <option value="">没有可用的 Shell</option>}
        {available.map((profile) => (
          <option key={profile.id} value={profile.id}>{profile.label}</option>
        ))}
      </select>
    </label>
  )
}
