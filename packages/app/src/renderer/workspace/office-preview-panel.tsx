// Office preview body: extracted from the preview pane so the pane stays a
// coordinator and this file owns the document/spreadsheet/slides rendering.
import type { WorkspacePreview } from '../api'

export function WorkspaceOfficePreview({
  preview,
}: {
  preview: Extract<WorkspacePreview, { kind: 'office' }>
}) {
  return (
    <div className={`workspace-office-preview ${preview.officeKind}`}>
      <div className="workspace-office-heading">
        <strong>{officeKindLabel(preview.officeKind)}</strong>
        {preview.note && <span>{preview.note}</span>}
        {preview.truncated && <span>内容较多，已按预览上限截取。</span>}
      </div>
      {preview.sections.length === 0 && (
        <div className="workspace-office-empty">文件已在 LS 内打开，但没有提取到可显示的文字。</div>
      )}
      {preview.officeKind === 'spreadsheet' ? (
        <div className="workspace-office-sheets">
          {preview.sections.map((section) => (
            <section className="workspace-office-sheet" key={section.title}>
              <h3>{section.title}</h3>
              <div className="workspace-office-table-wrap">
                <table>
                  <tbody>
                    {(section.rows ?? []).map((row, rowIndex) => (
                      <tr key={`${section.title}-${rowIndex}`}>
                        {row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="workspace-office-sections">
          {preview.sections.map((section) => (
            <section className="workspace-office-section" key={section.title}>
              <h3>{section.title}</h3>
              {(section.paragraphs ?? []).map((paragraph, index) => (
                <p key={`${section.title}-${index}`}>{paragraph}</p>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

export function officeKindLabel(kind: Extract<WorkspacePreview, { kind: 'office' }>['officeKind']): string {
  if (kind === 'spreadsheet') return '表格预览'
  if (kind === 'presentation') return '演示文稿预览'
  return '文档预览'
}
