// The path above a file is a trail of jump targets: every label but the file names a real folder,
// and the file itself stays the end of the trail rather than a button back to where it lives.
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { workspaceBreadcrumbFolders, workspaceBreadcrumbs } from './path-utils'

describe('preview breadcrumbs', () => {
  it('pairs every label with the folder it names, and the file with none', () => {
    const root = 'D:\\work\\game'
    const path = 'D:\\work\\game\\ssr\\panel\\shooter.html'

    expect(workspaceBreadcrumbs(root, path)).toEqual(['game', 'ssr', 'panel', 'shooter.html'])
    expect(workspaceBreadcrumbFolders(root, path)).toEqual([
      'D:\\work\\game',
      'D:\\work\\game\\ssr',
      'D:\\work\\game\\ssr\\panel',
      null,
    ])
  })

  it('still names the right folders after the label list drops leading parts', () => {
    // `workspaceBreadcrumbs` keeps the root name plus the last four parts, so the five labels the
    // reported path showed (`.codex_tmp / s3 / …`) no longer include the root. Pairing from the end
    // is what keeps each label honest, and the file still names no folder.
    const root = 'C:\\ws\\.codex_tmp'
    const path = 'C:\\ws\\.codex_tmp\\s3\\DGkYD8\\ssr\\0bf506d1\\deep\\file.html'

    expect(workspaceBreadcrumbs(root, path)).toEqual(['DGkYD8', 'ssr', '0bf506d1', 'deep', 'file.html'])
    expect(workspaceBreadcrumbFolders(root, path)).toEqual([
      'C:\\ws\\.codex_tmp\\s3\\DGkYD8',
      'C:\\ws\\.codex_tmp\\s3\\DGkYD8\\ssr',
      'C:\\ws\\.codex_tmp\\s3\\DGkYD8\\ssr\\0bf506d1',
      'C:\\ws\\.codex_tmp\\s3\\DGkYD8\\ssr\\0bf506d1\\deep',
      null,
    ])
  })

  it('offers no jump target for a path outside its root', () => {
    expect(workspaceBreadcrumbFolders('D:\\work', 'C:\\other\\file.txt')).toEqual([null, null])
  })

  it('gives an ancestor a surface wider than its glyphs, and the file the strongest colour', async () => {
    const breadcrumbs = await readFile(new URL('./preview-breadcrumbs.tsx', import.meta.url), 'utf8')
    const panel = await readFile(new URL('./panel.tsx', import.meta.url), 'utf8')
    const styles = await readFile(new URL('../styles/04-workspace.css', import.meta.url), 'utf8')

    expect(breadcrumbs).toContain('className="workspace-preview-crumb"')
    expect(breadcrumbs).toContain('onClick={() => onRevealFolder(folder)}')
    // The file itself is never a jump target back to where it already lives.
    expect(breadcrumbs).toContain('{folder && onRevealFolder ? (')

    // The pointer hits the segment, not the letters: the button pads out over the gap beside its
    // separator, and the hover fill is what shows it.
    const crumb = styles.slice(
      styles.indexOf('.workspace-preview-breadcrumbs .workspace-preview-crumb {'),
      styles.indexOf('.workspace-preview-breadcrumbs em {'),
    )
    const restingCrumb = crumb.slice(0, crumb.indexOf('.workspace-preview-breadcrumbs .workspace-preview-crumb:hover'))
    expect(restingCrumb).toContain('margin: 0 -3px;')
    expect(restingCrumb).toContain('padding: 1px 3px;')
    expect(restingCrumb).toContain('color: var(--muted);')
    expect(restingCrumb).toContain('border-radius: var(--radius-ui);')
    // Ancestors sit back at rest and only come forward under the pointer.
    expect(restingCrumb).not.toContain('var(--text-strong)')
    expect(crumb).toContain('background: var(--control-hover);')
    expect(styles).toMatch(/\.workspace-preview-breadcrumbs em \{[^}]*color: var\(--text-strong\);/u)

    // Clicking a crumb reveals that folder in the file navigator, so the folder column jumps there.
    expect(panel).toContain(
      'onRevealFolder={(folder) => onExpandedPathsChange((paths) => [...new Set([...paths, ...workspaceAncestorPaths(fileTab.root, folder)])])}',
    )
  })
})
