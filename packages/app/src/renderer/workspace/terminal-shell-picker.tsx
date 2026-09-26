// UX-29: the "new terminal" Shell choice.
//
// It shows the real shell names Main discovered, explains the ones that are unavailable
// instead of hiding them, and refuses to guess: every option it can offer is one Main
// validated on this machine. The control is a two-part pill — the left half starts a terminal
// with the current Shell at once, the chevron lists the alternatives.
import type { WorkspaceShellProfile } from '../api/terminal'
import { SplitButton } from '../ui/split-button'
import { WorkspaceFeatureIcon } from '../ui/icons'

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
      className="workspace-terminal-shell"
      icon={<WorkspaceFeatureIcon id="terminal" />}
      label={`终端 Shell：${currentLabel}`}
      primaryTip={missingHint
        ? `用 ${currentLabel} 新建终端。本机缺少：\n${missingHint}`
        : `用 ${currentLabel} 新建终端`}
      menuLabel="选择终端 Shell"
      disabled={available.length === 0}
      busy={busy}
      items={[
        ...available.map((profile) => ({
          id: profile.id,
          label: profile.label,
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
