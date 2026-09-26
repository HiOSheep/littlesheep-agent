import { describe, expect, it } from 'vitest'
import {
  discoverOpenWithHandlers,
  parseRegValue,
  parseRegValueNames,
  splitCommandLine,
} from './workspace-open-with.js'

const USER_CHOICE = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md\\UserChoice
    ProgId    REG_SZ    VisualStudioCode.md
`

const EXTENSION_KEY = `
HKEY_CLASSES_ROOT\\.md
    (Default)    REG_SZ    Markdown
    Content Type    REG_SZ    text/markdown
`

const OPEN_WITH_PROGIDS = `
HKEY_CLASSES_ROOT\\.md\\OpenWithProgids
    Applications\\notepad.exe    REG_NONE
    Markdown    REG_NONE
`

const CODE_COMMAND = `
HKEY_CLASSES_ROOT\\VisualStudioCode.md\\shell\\open\\command
    (Default)    REG_SZ    "C:\\Program Files\\Microsoft VS Code\\Code.exe" "%1"
`

const NOTEPAD_COMMAND = `
HKEY_CLASSES_ROOT\\Applications\\notepad.exe\\shell\\open\\command
    (Default)    REG_SZ    "C:\\Windows\\system32\\NOTEPAD.EXE" %1
`

const MARKDOWN_COMMAND = `
HKEY_CLASSES_ROOT\\Markdown\\shell\\open\\command
    (Default)    REG_SZ    "C:\\Tools\\markdown.exe" "%1"
`

function registry(entries: Record<string, string>) {
  return async (key: string): Promise<string> => {
    const found = entries[key]
    if (found === undefined) throw new Error(`missing key: ${key}`)
    return found
  }
}

describe('registry parsing', () => {
  it('reads a value out of `reg query` output', () => {
    expect(parseRegValue(CODE_COMMAND)).toBe('"C:\\Program Files\\Microsoft VS Code\\Code.exe" "%1"')
    expect(parseRegValue(USER_CHOICE, 'ProgId')).toBe('VisualStudioCode.md')
    expect(parseRegValue('HKEY_CLASSES_ROOT\\.md\n', 'ProgId')).toBeNull()
  })

  it('reads the default value whatever language the console names it in', () => {
    // A Chinese Windows prints `(默认)`, and reg.exe hands the bytes over as CP936 mojibake; both
    // look like a parenthesised name and neither is the literal `(Default)`.
    expect(parseRegValue('HKEY_CLASSES_ROOT\\.md\n    (默认)    REG_SZ    md_auto_file\n')).toBe('md_auto_file')
    expect(parseRegValue('HKEY_CLASSES_ROOT\\.md\n    (Ĭ��)    REG_SZ    md_auto_file\n')).toBe('md_auto_file')
  })

  it('reads the value names a key lists, ignoring the default value', () => {
    expect(parseRegValueNames(OPEN_WITH_PROGIDS)).toEqual(['Applications\\notepad.exe', 'Markdown'])
    expect(parseRegValueNames(EXTENSION_KEY)).toEqual(['Content Type'])
  })

  it('splits a command line into its executable and the line as written', () => {
    expect(splitCommandLine('"C:\\a b\\app.exe" "%1"')).toEqual({
      executable: 'C:\\a b\\app.exe',
      command: '"C:\\a b\\app.exe" "%1"',
    })
    expect(splitCommandLine('C:\\Windows\\notepad.exe %1')?.executable).toBe('C:\\Windows\\notepad.exe')
    expect(splitCommandLine('   ')).toBeNull()
  })
})

describe('open-with discovery', () => {
  it('offers the user-chosen default first, then the other registered handlers', async () => {
    const handlers = await discoverOpenWithHandlers('C:\\work\\readme.md', {
      platform: 'win32',
      regQuery: registry({
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md\\UserChoice': USER_CHOICE,
        'HKCR\\.md': EXTENSION_KEY,
        'HKCR\\.md\\OpenWithProgids': OPEN_WITH_PROGIDS,
        'HKCR\\VisualStudioCode.md\\shell\\open\\command': CODE_COMMAND,
        'HKCR\\Markdown\\shell\\open\\command': MARKDOWN_COMMAND,
        'HKCR\\Applications': `
HKEY_CLASSES_ROOT\\Applications
    notepad.exe    REG_SZ
`,
        'HKCR\\Applications\\notepad.exe\\SupportedTypes': `
HKEY_CLASSES_ROOT\\Applications\\notepad.exe\\SupportedTypes
    .md    REG_SZ
`,
        'HKCR\\Applications\\notepad.exe\\shell\\open\\command': NOTEPAD_COMMAND,
      }),
    })

    expect(handlers.map((handler) => handler.label)).toEqual(['Code', 'markdown', 'NOTEPAD'])
    expect(handlers[0]).toMatchObject({
      id: 'c:\\program files\\microsoft vs code\\code.exe',
      command: '"C:\\Program Files\\Microsoft VS Code\\Code.exe" "%1"',
      isDefault: true,
    })
    expect(handlers.filter((handler) => handler.isDefault)).toHaveLength(1)
  })

  it('never offers a handler the registry cannot give a command for', async () => {
    const handlers = await discoverOpenWithHandlers('C:\\work\\readme.md', {
      platform: 'win32',
      regQuery: registry({
        'HKCR\\.md': EXTENSION_KEY,
        'HKCR\\.md\\OpenWithProgids': OPEN_WITH_PROGIDS,
        'HKCR\\Markdown\\shell\\open\\command': MARKDOWN_COMMAND,
      }),
    })

    expect(handlers).toHaveLength(1)
    expect(handlers[0]?.executable).toBe('C:\\Tools\\markdown.exe')
    expect(handlers.every((handler) => handler.isDefault)).toBe(false)
  })

  it('prefers the friendly application name when the registry has one', async () => {
    const handlers = await discoverOpenWithHandlers('C:\\work\\readme.md', {
      platform: 'win32',
      regQuery: registry({
        'HKCR\\.md\\OpenWithList': `
HKEY_CLASSES_ROOT\\.md\\OpenWithList
    a    REG_SZ    Code.exe
`,
        'HKCR\\Applications': `
HKEY_CLASSES_ROOT\\Applications
    Code.exe    REG_SZ
`,
        'HKCR\\Applications\\Code.exe\\SupportedTypes': `
HKEY_CLASSES_ROOT\\Applications\\Code.exe\\SupportedTypes
    .md    REG_SZ
`,
        'HKCR\\Applications\\Code.exe': `
HKEY_CLASSES_ROOT\\Applications\\Code.exe
    FriendlyAppName    REG_SZ    Visual Studio Code
`,
        'HKCR\\Applications\\Code.exe\\shell\\open\\command': CODE_COMMAND,
      }),
    })

    expect(handlers).toHaveLength(1)
    expect(handlers[0]?.label).toBe('Visual Studio Code')
  })

  it('drops a friendly name the console codepage garbled', async () => {
    const handlers = await discoverOpenWithHandlers('C:\\work\\readme.md', {
      platform: 'win32',
      regQuery: registry({
        'HKCR\\.md\\OpenWithList': `
HKEY_CLASSES_ROOT\\.md\\OpenWithList
    a    REG_SZ    Code.exe
`,
        'HKCR\\Applications': `
HKEY_CLASSES_ROOT\\Applications
    Code.exe    REG_SZ
`,
        'HKCR\\Applications\\Code.exe\\SupportedTypes': `
HKEY_CLASSES_ROOT\\Applications\\Code.exe\\SupportedTypes
    .md    REG_SZ
`,
        'HKCR\\Applications\\Code.exe': `
HKEY_CLASSES_ROOT\\Applications\\Code.exe
    FriendlyAppName    REG_SZ    �ǼǱ�
`,
        'HKCR\\Applications\\Code.exe\\shell\\open\\command': CODE_COMMAND,
      }),
    })

    expect(handlers).toHaveLength(1)
    expect(handlers[0]?.label).toBe('Code')
  })

  it('stays honest off Windows and for paths without an extension', async () => {
    const query = registry({})
    expect(await discoverOpenWithHandlers('C:\\work\\readme.md', { platform: 'darwin', regQuery: query })).toEqual([])
    expect(await discoverOpenWithHandlers('C:\\work\\README', { platform: 'win32', regQuery: query })).toEqual([])
  })

  it('bounds the list and survives a registry that answers nothing', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `HKCR\\Prog${index}\\shell\\open\\command`,
        `HKEY_CLASSES_ROOT\\Prog${index}\\shell\\open\\command\n    (Default)    REG_SZ    "C:\\Tools\\app${index}.exe" "%1"\n`,
      ]),
    )
    const handlers = await discoverOpenWithHandlers('C:\\work\\readme.md', {
      platform: 'win32',
      limit: 5,
      regQuery: registry({
        'HKCR\\.md\\OpenWithProgids': `
HKEY_CLASSES_ROOT\\.md\\OpenWithProgids
${Array.from({ length: 40 }, (_, index) => `    Prog${index}    REG_NONE`).join('\n')}
`,
        ...many,
      }),
    })
    expect(handlers).toHaveLength(5)

    const empty = await discoverOpenWithHandlers('C:\\work\\readme.md', {
      platform: 'win32',
      regQuery: async () => {
        throw new Error('reg.exe is unavailable')
      },
    })
    expect(empty).toEqual([])
  })
})
