// Shared file glyphs. Format marks are local SVG assets; their source and licence live beside them.
import typescript from './file-glyph-assets/typescript.svg?url'
import javascript from './file-glyph-assets/javascript.svg?url'
import markdown from './file-glyph-assets/markdown.svg?url'
import python from './file-glyph-assets/python.svg?url'
import git from './file-glyph-assets/git.svg?url'
import json from './file-glyph-assets/json.svg?url'
import yaml from './file-glyph-assets/yaml.svg?url'
import html from './file-glyph-assets/html.svg?url'
import css from './file-glyph-assets/css.svg?url'
import rust from './file-glyph-assets/rust.svg?url'
import go from './file-glyph-assets/go.svg?url'
import java from './file-glyph-assets/java.svg?url'
import csharp from './file-glyph-assets/csharp.svg?url'
import shell from './file-glyph-assets/console.svg?url'
import pdf from './file-glyph-assets/pdf.svg?url'
import database from './file-glyph-assets/database.svg?url'
import config from './file-glyph-assets/settings.svg?url'
import lock from './file-glyph-assets/lock.svg?url'

export type FileGlyphKind =
  | 'markdown' | 'typescript' | 'javascript' | 'python' | 'json' | 'css' | 'html' | 'yaml'
  | 'shell' | 'rust' | 'go' | 'java' | 'csharp' | 'git' | 'lock' | 'image' | 'pdf'
  | 'database' | 'config' | 'generic'

const FILE_GLYPH_ASSETS: Record<Exclude<FileGlyphKind, 'generic' | 'image'>, string> = {
  markdown, typescript, javascript, python, json, css, html, yaml,
  shell, rust, go, java, csharp, git, lock, pdf, database, config,
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

/** Folders stay quieter than the format marks: a warm outline and a lightly tinted interior. */
export function FolderGlyphIcon() {
  return (
    <svg className="workspace-tree-glyph-icon folder-glyph-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path className="folder-glyph-body" d="M1.5 5.25V4c0-.83.67-1.5 1.5-1.5h2.65c.4 0 .78.16 1.06.44l1.12 1.12c.28.28.66.44 1.06.44H13c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5H3c-.83 0-1.5-.67-1.5-1.5z" />
      <path className="folder-glyph-seam" d="M1.75 5.5h4.6" />
    </svg>
  )
}

export function FileGlyphIcon({ name }: { name?: string } = {}) {
  const kind = fileGlyphKind(name)
  const className = `workspace-tree-glyph-icon file-glyph-icon file-glyph-${kind}`
  if (kind === 'generic') {
    return <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path className="file-glyph-sheet" d="M9 1.75H4.5c-.83 0-1.5.67-1.5 1.5v9.5c0 .83.67 1.5 1.5 1.5h7c.83 0 1.5-.67 1.5-1.5V5.75z" /><path className="file-glyph-fold" d="M9 1.75v3c0 .55.45 1 1 1h3" /></svg>
  }
  if (kind === 'image') {
    return <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect className="file-glyph-image-frame" x="1.75" y="2.25" width="12.5" height="11.5" rx="2" /><circle className="file-glyph-image-sun" cx="5.25" cy="5.75" r="1" /><path className="file-glyph-image-mountains" d="m2.25 11.5 3.5-3.75 2.5 2.5 2-2.25 3.5 3.75" /></svg>
  }
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <image className="file-glyph-format-mark" href={FILE_GLYPH_ASSETS[kind]} x="0" y="0" width="16" height="16" />
    </svg>
  )
}
