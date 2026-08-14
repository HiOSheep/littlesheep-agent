import { describe, expect, it } from 'vitest'
import { previewLanguageForWorkspaceFile } from './workspace-file-routing'
import {
  normalizeWorkspaceLanguageId,
  workspaceLanguageForFile,
  workspaceLanguageForPath,
} from '../shared/workspace-languages'

describe('workspace language registry', () => {
  it.each([
    ['app.py', '.py', 'python'],
    ['main.rs', '.rs', 'rust'],
    ['Program.cs', '.cs', 'csharp'],
    ['script.rb', '.rb', 'ruby'],
    ['Main.kt', '.kt', 'kotlin'],
    ['Library.fs', '.fs', 'fsharp'],
    ['module.hs', '.hs', 'haskell'],
    ['config.toml', '.toml', 'toml'],
    ['package.json', '.json', 'json'],
    ['Dockerfile', '', 'dockerfile'],
  ])('maps %s to %s', (name, extension, expected) => {
    expect(workspaceLanguageForFile(name.toLowerCase(), extension)).toBe(expected)
  })

  it('uses the same registry from the main-process preview route', () => {
    expect(previewLanguageForWorkspaceFile('server.py', '.py')).toBe('python')
    expect(previewLanguageForWorkspaceFile('lib.rs', '.rs')).toBe('rust')
  })

  it('routes review model paths through the same registry', () => {
    expect(workspaceLanguageForPath('src/components/Panel.tsx')).toBe('typescript')
    expect(workspaceLanguageForPath('config\\settings.toml')).toBe('toml')
    expect(workspaceLanguageForPath('Dockerfile')).toBe('dockerfile')
  })

  it('normalizes unknown language ids to plaintext', () => {
    expect(normalizeWorkspaceLanguageId('not-a-language')).toBe('plaintext')
    expect(normalizeWorkspaceLanguageId('TypeScript')).toBe('typescript')
  })
})
