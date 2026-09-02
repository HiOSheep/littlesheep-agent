// File-type glyph classification and rendering for workspace surfaces.

export type FileGlyphKind =
  | 'markdown' | 'typescript' | 'javascript' | 'python' | 'json' | 'css' | 'html' | 'yaml'
  | 'shell' | 'rust' | 'go' | 'java' | 'csharp' | 'git' | 'lock' | 'image' | 'pdf'
  | 'database' | 'config' | 'generic'

const FILE_GLYPH_LABELS: Partial<Record<FileGlyphKind, string>> = {
  markdown: 'M', typescript: 'TS', javascript: 'JS', python: 'Py', json: '{}', css: '#',
  html: '<>', yaml: 'YML', shell: '>_', rust: 'Rs', go: 'Go', java: 'J', csharp: 'C#',
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

export function FileGlyphIcon({ name }: { name?: string } = {}) {
  const kind = fileGlyphKind(name)
  const className = `workspace-tree-glyph-icon file-glyph-icon file-glyph-${kind}`
  if (kind === 'generic') {
    return <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 2.15h5.15L12 5v8.15c0 .55-.45 1-1 1H4c-.55 0-1-.45-1-1V3.15c0-.55.45-1 1-1zM9.15 2.3v2.4c0 .4.3.7.7.7h1.95" /></svg>
  }
  if (kind === 'image') {
    return <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect className="file-glyph-image-frame" x="2.1" y="2.1" width="11.8" height="11.8" rx="1.6" /><circle className="file-glyph-image-sun" cx="5.3" cy="5.4" r="1.1" /><path className="file-glyph-image-mountains" d="m3.45 11.65 2.9-3.15 2.15 1.95 1.45-1.35 2.6 2.55" /></svg>
  }
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path className="file-glyph-sheet" d="M3.2 1.65h6.15l4 4v7.6c0 .58-.47 1.05-1.05 1.05H3.2c-.58 0-1.05-.47-1.05-1.05V2.7c0-.58.47-1.05 1.05-1.05z" />
      <path className="file-glyph-fold" d="M9.2 1.8v4.65h4.45" />
      {kind === 'lock' ? <><rect className="file-glyph-lock-body" x="5.15" y="7.25" width="5.7" height="4.55" rx="0.9" /><path className="file-glyph-lock-shackle" d="M6.55 7.25V6.1a1.45 1.45 0 0 1 2.9 0v1.15" /></> : <text className={`file-glyph-label file-glyph-label-${kind}`} x="8" y="10.55" textAnchor="middle">{FILE_GLYPH_LABELS[kind] ?? ''}</text>}
    </svg>
  )
}
