// File-type glyph classification and rendering for workspace surfaces.
//
// Shape language: every glyph is a rounded, filled plate in the file type's own colour — a folder
// with a rounded tab and a light bar, a sheet with rounded corners and a folded top-right corner,
// plus the type's own mark (JS / TS / 5 / 3 / MD / …). Colours and marks follow each type's
// official logo (HTML5 orange with "5", CSS3 blue with "3", JavaScript yellow with "JS", Markdown
// blue with "MD", Go cyan with "Go", …); the geometry is redrawn here so the corners stay round at
// the 16px the navigator renders them.

export type FileGlyphKind =
  | 'markdown' | 'typescript' | 'javascript' | 'python' | 'json' | 'css' | 'html' | 'yaml'
  | 'shell' | 'rust' | 'go' | 'java' | 'csharp' | 'git' | 'lock' | 'image' | 'pdf'
  | 'database' | 'config' | 'generic'

const FILE_GLYPH_LABELS: Partial<Record<FileGlyphKind, string>> = {
  markdown: 'MD', typescript: 'TS', javascript: 'JS', python: 'Py', json: '{}', css: '3',
  html: '5', yaml: 'YL', shell: '>_', rust: 'Rs', go: 'Go', java: 'J', csharp: 'C#',
  git: 'git', lock: 'L', pdf: 'PDF', database: 'SQL', config: '{}',
}

export function fileGlyphKind(name = ''): FileGlyphKind {
  const fileName = name.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? ''
  if (!fileName) return 'generic'
  if (fileName === 'package-lock.json' || fileName === 'yarn.lock' || fileName === 'pnpm-lock.yaml' || fileName === 'cargo.lock') return 'lock'
  if (fileName === '.gitignore' || fileName === '.gitattributes' || fileName === '.gitmodules' || fileName === '.gitkeep') return 'git'
  if (fileName === 'dockerfile' || fileName === 'makefile' || fileName === 'justfile') return 'config'
  if (fileName.startsWith('.env')) return 'config'

  const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : ''
  if (['md', 'markdown', 'mdown', 'mkd', 'mdx'].includes(extension)) return 'markdown'
  if (['ts', 'tsx', 'mts', 'cts'].includes(extension)) return 'typescript'
  if (['js', 'jsx', 'mjs', 'cjs'].includes(extension)) return 'javascript'
  if (['py', 'pyw', 'pyi'].includes(extension)) return 'python'
  if (['json', 'jsonc', 'json5'].includes(extension)) return 'json'
  if (['css', 'scss', 'sass', 'less'].includes(extension)) return 'css'
  if (['html', 'htm', 'xhtml', 'vue'].includes(extension)) return 'html'
  if (['yml', 'yaml'].includes(extension)) return 'yaml'
  if (['sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd'].includes(extension)) return 'shell'
  if (extension === 'rs') return 'rust'
  if (extension === 'go') return 'go'
  if (extension === 'java') return 'java'
  if (['cs', 'csx'].includes(extension)) return 'csharp'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(extension)) return 'image'
  if (extension === 'pdf') return 'pdf'
  if (['sql', 'db', 'sqlite', 'sqlite3'].includes(extension)) return 'database'
  if (['lock', 'lockfile'].includes(extension)) return 'lock'
  if (['ini', 'toml', 'conf', 'config', 'properties'].includes(extension) || fileName === '.editorconfig') return 'config'
  return 'generic'
}

/** The sheet every file glyph is drawn on, in the 16×16 glyph box: 3px corner radii, folded corner. */
const FILE_GLYPH_SHEET = 'M4.05 1.55h4.55c.42 0 .83.17 1.13.47l2.75 2.75c.3.3.47.71.47 1.13v7.05c0 .88-.72 1.6-1.6 1.6H4.05c-.88 0-1.6-.72-1.6-1.6V3.15c0-.88.72-1.6 1.6-1.6z'
const FILE_GLYPH_FOLD = 'M8.95 1.62v3.02c0 .44.36.8.8.8h3.02'
/** The folded corner itself, filled lighter than the sheet so the fold reads at 14px. */
const FILE_GLYPH_FOLD_FILL = 'M9.15 1.58h.6l3.05 3.05v.6h-2.85c-.44 0-.8-.36-.8-.8z'

/** Fills the same rounded plate for the folder row: tab on the left, light bar across the middle. */
export function FolderGlyphIcon() {
  return (
    <svg className="workspace-tree-glyph-icon folder-glyph-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path className="folder-glyph-body" d="M1.85 4.45c0-1.1.9-2 2-2h2.08c.53 0 1.04.21 1.42.59l.67.67c.38.38.89.59 1.42.59h2.71c1.1 0 2 .9 2 2v5.25c0 1.1-.9 2-2 2H3.85c-1.1 0-2-.9-2-2z" />
      <rect className="folder-glyph-bar" x="4.05" y="7.3" width="7.9" height="2.35" rx="1.17" />
    </svg>
  )
}

export function FileGlyphIcon({ name }: { name?: string } = {}) {
  const kind = fileGlyphKind(name)
  const className = `workspace-tree-glyph-icon file-glyph-icon file-glyph-${kind}`
  if (kind === 'generic') {
    return <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path className="file-glyph-sheet" d={FILE_GLYPH_SHEET} /><path className="file-glyph-fold-fill" d={FILE_GLYPH_FOLD_FILL} /><path className="file-glyph-fold" d={FILE_GLYPH_FOLD} /></svg>
  }
  if (kind === 'image') {
    return <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect className="file-glyph-image-frame" x="1.95" y="1.95" width="12.1" height="12.1" rx="3.1" /><circle className="file-glyph-image-sun" cx="5.5" cy="5.6" r="1.15" /><path className="file-glyph-image-mountains" d="m3.35 11.75 2.95-3.2 2.2 2 1.5-1.4 2.65 2.6" /></svg>
  }
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path className="file-glyph-sheet" d={FILE_GLYPH_SHEET} />
      <path className="file-glyph-fold-fill" d={FILE_GLYPH_FOLD_FILL} />
      <path className="file-glyph-fold" d={FILE_GLYPH_FOLD} />
      {kind === 'lock' ? <><rect className="file-glyph-lock-body" x="5.15" y="7.25" width="5.7" height="4.55" rx="1.5" /><path className="file-glyph-lock-shackle" d="M6.55 7.25V6.15a1.45 1.45 0 0 1 2.9 0v1.1" /></> : <text className={`file-glyph-label file-glyph-label-${kind}`} x="8" y="10.9" textAnchor="middle">{FILE_GLYPH_LABELS[kind] ?? ''}</text>}
    </svg>
  )
}
