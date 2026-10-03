import { describe, expect, it } from 'vitest'
import { resolveOpenWithInvocation } from './workspace-open-with.js'

describe('open-with invocation', () => {
  it('substitutes the file into the registry placeholder', () => {
    expect(resolveOpenWithInvocation('"C:\\Program Files\\Microsoft VS Code\\Code.exe" "%1"', 'C:\\w\\a.md'))
      .toEqual({ executable: 'C:\\Program Files\\Microsoft VS Code\\Code.exe', args: ['C:\\w\\a.md'] })
  })

  it('keeps extra switches and their order', () => {
    expect(resolveOpenWithInvocation('"C:\\Tools\\app.exe" -s "%1" --flag', 'C:\\w\\a b.md'))
      .toEqual({ executable: 'C:\\Tools\\app.exe', args: ['-s', 'C:\\w\\a b.md', '--flag'] })
  })

  it('passes the file when the entry has no placeholder, and refuses empty commands', () => {
    expect(resolveOpenWithInvocation('C:\\Windows\\notepad.exe', 'C:\\w\\a.md'))
      .toEqual({ executable: 'C:\\Windows\\notepad.exe', args: ['C:\\w\\a.md'] })
    expect(resolveOpenWithInvocation('   ', 'C:\\w\\a.md')).toBeNull()
  })

  it('keeps a spaced path in one argument when the registry does not quote its placeholder', () => {
    expect(resolveOpenWithInvocation('editor.exe --reuse %1', 'C:\\my work\\a b.md'))
      .toEqual({ executable: 'editor.exe', args: ['--reuse', 'C:\\my work\\a b.md'] })
  })

  it('appends the file after switches when the registry has no placeholder', () => {
    expect(resolveOpenWithInvocation('editor.exe --reuse', 'C:\\w\\a.md'))
      .toEqual({ executable: 'editor.exe', args: ['--reuse', 'C:\\w\\a.md'] })
  })
})
