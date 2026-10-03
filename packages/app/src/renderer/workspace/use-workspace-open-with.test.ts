import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { isSameExecutableAsVSCode } from './use-workspace-open-with'

describe('open-with dedupe', () => {
  it('recognizes the external editor under any install path', () => {
    expect(isSameExecutableAsVSCode('C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe')).toBe(true)
    expect(isSameExecutableAsVSCode('D:\\Tools\\Code - Insiders.exe')).toBe(true)
    expect(isSameExecutableAsVSCode('D:\\Obsidian\\Obsidian.exe')).toBe(false)
    expect(isSameExecutableAsVSCode('C:\\Windows\\notepad.exe')).toBe(false)
  })
})

/**
 * The folder is a remembered choice, not only a one-off entry: a reader who wants files revealed in
 * the file manager instead of opened in an editor picks it once, and the primary segment does that
 * from then on (asked for 2026-10-03). The hook already stores and validates the id; these assertions
 * pin the wiring that uses it, which a node test cannot render.
 */
describe('open-with folder choice', () => {
  const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

  it('keeps the stored folder choice as the current one', async () => {
    const hook = await source('./use-workspace-open-with.ts')
    expect(hook).toContain('storedChoice === OPEN_WITH_REVEAL_ID')
    expect(hook).toContain('if (id === OPEN_WITH_REVEAL_ID || !path) {')
    expect(hook).toContain('openWithCurrent: () => openWith(currentId)')
  })

  it('lets the menu entry reveal and stay the choice, and names it on the primary segment', async () => {
    const actions = await source('./preview-actions.tsx')

    expect(actions).toContain('const currentIsFolder = openWith.currentId === OPEN_WITH_REVEAL_ID')
    expect(actions).toContain("? '文件夹'")
    expect(actions).toContain("primaryTip={currentIsFolder ? '在文件夹中显示这个文件'")
    // The folder entry selects through the same remembered path as every launcher, and shows which
    // choice is in force.
    expect(actions).toMatch(/id: OPEN_WITH_REVEAL_ID,[\s\S]{0,400}active: currentIsFolder,/u)
    expect(actions).toMatch(/dividerBefore: true,\s*onSelect: \(\) => openWith\.openWith\(OPEN_WITH_REVEAL_ID\),/u)
  })

  it('claims the default once, on the system handler rather than on its own entry', async () => {
    const actions = await source('./preview-actions.tsx')

    // Two rows used to read "（默认）": the built-in VS Code entry and the system's own handler for
    // the extension (reported 2026-10-03). Only the system's keeps the claim, and it says whose.
    expect(actions).toContain("label: 'Visual Studio Code',")
    expect(actions).not.toContain('Visual Studio Code（默认）')
    expect(actions).toContain('label: handler.isDefault ? `${handler.label}（系统默认）` : handler.label,')
  })
})
