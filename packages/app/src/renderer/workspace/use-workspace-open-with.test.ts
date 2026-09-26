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
