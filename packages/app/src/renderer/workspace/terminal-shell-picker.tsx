// UX-29: the "new terminal" Shell choice.
//
// It shows the real shell names Main discovered, explains the ones that are unavailable
// instead of hiding them, and refuses to guess: every option it can offer is one Main
// validated on this machine. The control is a two-part pill — the left half starts a terminal
// with the current Shell at once, the chevron lists the alternatives.
import type { WorkspaceShellProfile } from '../api/terminal'
import { SplitButton } from '../ui/split-button'
import { WorkspaceFeatureIcon } from '../ui/icons'

function TerminalShellGlyph({ kind }: { kind: WorkspaceShellProfile['kind'] }) {
  const powershell = kind === 'windows-powershell' || kind === 'powershell-7'
  return <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true" data-shell-kind={kind}>
    <rect x="1" y="3" width="18" height="14" rx="3" fill={powershell ? '#2879cf' : 'currentColor'} fillOpacity={powershell ? 1 : .18} />
    <text x="10" y="12.8" textAnchor="middle" fill={powershell ? '#fff' : 'currentColor'} fontFamily="monospace" fontSize="7.5" fontWeight="600">{powershell ? 'PS' : kind === 'wsl' ? 'WSL' : kind === 'cmd' ? '>_' : '$_'}</text>
  </svg>
}

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
  const current = available.find((profile) => profile.id === selectedId) ?? available[0] ?? null
  const currentLabel = current?.label ?? '没有可用的 Shell'

  return (
    <SplitButton
      // Not `workspace-terminal-shell`: that class belongs to the xterm host (10px padding, its own
      // background, the SimSun stack). Borrowing it put 10px of padding inside this 25px pill, so
      // the segments' content box collapsed to 3px and the terminal glyph rendered 6.5px below the
      // pill's centre (measured on the reported screenshot, 2026-10-01).
      className="workspace-terminal-shell-picker"
      icon={current ? <TerminalShellGlyph kind={current.kind} /> : <WorkspaceFeatureIcon id="terminal" />}
      label={`终端 Shell：${currentLabel}`}
      primaryTip={missingHint
        ? `用 ${currentLabel} 新建终端。本机缺少：\n${missingHint}`
        : `用 ${currentLabel} 新建终端`}
      menuLabel="选择终端 Shell"
      disabled={available.length === 0}
      disabledReason={available.length === 0
        ? `本机没有可用的终端 Shell${missingHint ? `：\n${missingHint}` : ''}`
        : undefined}
      busy={busy}
      items={[
        ...available.map((profile) => ({
          id: profile.id,
          label: profile.label,
          icon: <TerminalShellGlyph kind={profile.kind} />,
          active: profile.id === current?.id,
          onSelect: () => onSelect(profile.id),
        })),
        ...missing.map((profile) => ({
          id: `missing-${profile.id}`,
          label: `${profile.label}（不可用）`,
          hint: profile.reason ?? '不可用',
          disabled: true,
          onSelect: () => undefined,
        })),
      ]}
      onPrimary={() => {
        if (current) onSelect(current.id)
      }}
      // The picker's own contract stays `{ label, x, y }`; the split button speaks the floating
      // help tip shape, so the two are translated here rather than at every call site.
      onTipChange={(tip) => onTipChange?.(tip ? { label: tip.text, x: tip.x, y: tip.y } : null)}
    />
  )
}
