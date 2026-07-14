// Extension workspace panels, files, terminal, artifacts, and view helpers.


export function WorkspacePlaceholder({ title, text }: { title: string; text: string }) {
  return (
    <div className="workspace-placeholder">
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  )
}
