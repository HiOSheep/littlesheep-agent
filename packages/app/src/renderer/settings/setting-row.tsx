import type { ReactNode } from 'react'

/**
 * A settings row.
 *
 * `field` is the row's address in the S3 field index (`settings/search-index.ts`): it becomes
 * `data-settings-field`, which is how a search result lands on this exact row. The id is not
 * derived from the title, so renaming the label does not silently detach the row from the index
 * (`search-index.test.ts` scans both sides).
 */
export function SettingRow({ title, description, field, children }: {
  title: string
  description?: string
  field?: string
  children: ReactNode
}) {
  return <div className="settings-value-row" data-settings-field={field}>
    <div className="settings-value-copy"><strong>{title}</strong>{description && <small>{description}</small>}</div>
    <div className="settings-value-control">{children}</div>
  </div>
}
