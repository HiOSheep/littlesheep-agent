import type { ReactNode } from 'react'

export function SettingRow({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className="settings-value-row">
    <div className="settings-value-copy"><strong>{title}</strong>{description && <small>{description}</small>}</div>
    <div className="settings-value-control">{children}</div>
  </div>
}
