// @littlesheep/app - workspace-open-with.ts
// "Open with" for a workspace file: which applications this machine can actually open it with.
//
// Windows keeps that list in the registry, and the desktop's own picker is built from the same
// places, so there is no API to ask — the entries are read from the same keys Explorer reads:
//   HKCU\...\FileExts\<ext>\UserChoice   → the user's chosen ProgId (the real default)
//   HKCR\<ext>                           → the ProgId default plus OpenWithProgids / OpenWithList
//   HKCR\Applications\<exe>\SupportedTypes → applications that register the extension themselves
//   HKCR\<ProgId>\shell\open\command     → the command line to run
//
// Honesty rules, the same ones the terminal shell discovery follows: nothing is offered that Main
// cannot start, an entry without a usable command is dropped rather than guessed, the list is
// bounded, and discovery never blocks a preview — a failed query is an empty list, not an error.

import { execFile } from 'node:child_process'
import { basename, extname } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface WorkspaceOpenWithHandler {
  /** Stable id the renderer sends back: the executable, lower-cased. */
  id: string
  label: string
  /** The registry command line, with `%1` left in place for the caller to substitute. */
  command: string
  executable: string
  isDefault: boolean
}

export interface WorkspaceOpenWithOptions {
  platform?: NodeJS.Platform
  /** Injectable so the parsing is testable without the matching machine. */
  regQuery?: (key: string, value?: string) => Promise<string>
  /** Injectable: resolves an executable's own description for a friendlier label. */
  describeExecutable?: (path: string) => Promise<string | null>
  limit?: number
}

const DEFAULT_LIMIT = 12

/** `reg query` prints `    (Default)    REG_SZ    value`; this pulls the value out. */
export function parseRegValue(output: string, valueName?: string): string | null {
  const wanted = valueName?.toLowerCase()
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s{2,}(\S(?:.*?\S)?)\s{4,}REG_(?:SZ|EXPAND_SZ|MULTI_SZ)\s{4,}(.*)$/u.exec(line)
    if (!match) continue
    const name = match[1]?.trim() ?? ''
    // The default value is named in the console's language — a Chinese Windows prints `(默认)` and
    // the bytes arrive as CP936 mojibake. Matching the literal `(Default)` would find nothing there,
    // so any parenthesised name counts as the default.
    const isDefaultName = name.startsWith('(') && name.endsWith(')')
    if (wanted ? name.toLowerCase() !== wanted : !isDefaultName) continue
    return (match[2] ?? '').trim() || null
  }
  return null
}

/** The value *names* under a key, which is how OpenWithProgids and OpenWithList list entries. */
export function parseRegValueNames(output: string): string[] {
  const names: string[] = []
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s{4}(\S(?:.*?\S)?)\s{4,}REG_/u.exec(line)
    if (!match) continue
    const name = match[1]?.trim()
    if (!name || name.toLowerCase() === '(default)') continue
    names.push(name)
  }
  return names
}

/** `"C:\Program Files\App\app.exe" "%1"` → the executable and the command line as written. */
export function splitCommandLine(command: string): { executable: string; command: string } | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  const quoted = /^"([^"]+)"/u.exec(trimmed)
  if (quoted?.[1]) return { executable: quoted[1], command: trimmed }
  const bare = /^(\S+\.exe)\b/iu.exec(trimmed)
  if (bare?.[1]) return { executable: bare[1], command: trimmed }
  const first = trimmed.split(/\s+/u)[0]
  if (!first) return null
  return { executable: first, command: trimmed }
}

function labelFromExecutable(executable: string): string {
  const name = basename(executable).replace(/\.exe$/iu, '')
  return name || executable
}

/**
 * `FriendlyAppName` comes back through the console codepage, so a non-ASCII name can arrive as
 * replacement characters. A garbled label is worse than a plain executable name, so it is dropped.
 */
function usableLabel(label: string | null, executable: string): string {
  const trimmed = label?.trim() ?? ''
  if (!trimmed || trimmed.includes('\uFFFD')) return labelFromExecutable(executable)
  return trimmed
}

export async function discoverOpenWithHandlers(
  filePath: string,
  options: WorkspaceOpenWithOptions = {},
): Promise<WorkspaceOpenWithHandler[]> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return []
  const query = options.regQuery ?? defaultRegQuery
  const limit = options.limit ?? DEFAULT_LIMIT
  const extension = extname(filePath).toLowerCase()
  if (!extension) return []

  // Every query is best-effort: a key that does not exist is a missing candidate, not a failure.
  const safeQuery = async (key: string, value?: string): Promise<string | null> => {
    try {
      return await query(key, value)
    } catch {
      return null
    }
  }

  const userChoice = await safeQuery(
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${extension}\\UserChoice`,
    'ProgId',
  )
  // `reg query /v <name>` prints that value under its own name, not as `(Default)`.
  const defaultProgId = userChoice ? parseRegValue(userChoice, 'ProgId') : null
  const extensionKey = await safeQuery(`HKCR\\${extension}`)
  const extensionProgId = extensionKey ? parseRegValue(extensionKey) : null
  const openWithProgids = await safeQuery(`HKCR\\${extension}\\OpenWithProgids`)
  const openWithList = await safeQuery(`HKCR\\${extension}\\OpenWithList`)
  const applications = await safeQuery('HKCR\\Applications')

  const progIds = new Set<string>()
  if (defaultProgId) progIds.add(defaultProgId)
  if (extensionProgId) progIds.add(extensionProgId)
  for (const name of openWithProgids ? parseRegValueNames(openWithProgids) : []) progIds.add(name)
  const executables = new Set<string>()
  for (const name of openWithList ? parseRegValueNames(openWithList) : []) executables.add(name)
  for (const name of applications ? parseRegValueNames(applications) : []) {
    if (name.toLowerCase().endsWith('.exe')) executables.add(name)
  }

  const handlers = new Map<string, WorkspaceOpenWithHandler>()
  const add = (command: string | null, labelHint: string | null, isDefault: boolean) => {
    if (!command) return
    const parsed = splitCommandLine(command)
    if (!parsed) return
    const id = parsed.executable.toLowerCase()
    const existing = handlers.get(id)
    if (existing) {
      if (isDefault && !existing.isDefault) handlers.set(id, { ...existing, isDefault: true })
      return
    }
    handlers.set(id, {
      id,
      label: usableLabel(labelHint, parsed.executable),
      command: parsed.command,
      executable: parsed.executable,
      isDefault,
    })
  }

  for (const progId of progIds) {
    if (!progId) continue
    const command = await safeQuery(`HKCR\\${progId}\\shell\\open\\command`)
    if (handlers.size >= limit) break
    add(command ? parseRegValue(command) : null, null, progId === defaultProgId)
  }

  for (const executable of executables) {
    if (handlers.size >= limit) break
    const id = executable.toLowerCase()
    if (handlers.has(id)) continue
    if (!executable.toLowerCase().endsWith('.exe')) continue
    // Applications that register the extension themselves: only offered when they really list it.
    const supported = await safeQuery(`HKCR\\Applications\\${executable}\\SupportedTypes`)
    const openWith = await safeQuery(`HKCR\\Applications\\${executable}\\shell\\open\\command`)
    const listsExtension = supported
      ? parseRegValueNames(supported).some((name) => name.toLowerCase() === extension)
      : false
    const isDefaultApplication = executable.toLowerCase() === (defaultProgId ?? '').toLowerCase()
    if (!listsExtension && !isDefaultApplication) continue
    const friendly = await safeQuery(`HKCR\\Applications\\${executable}`, 'FriendlyAppName')
    add(openWith ? parseRegValue(openWith) : null, friendly ? parseRegValue(friendly, 'FriendlyAppName') : null, isDefaultApplication)
  }

  return [...handlers.values()]
    .sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1
      return left.label.localeCompare(right.label, 'zh-Hans-CN', { sensitivity: 'base' })
    })
    .slice(0, limit)
}

async function defaultRegQuery(key: string, value?: string): Promise<string> {
  const args = ['query', key, ...(value ? ['/v', value] : [])]
  const { stdout } = await run('reg.exe', args, { windowsHide: true, timeout: 4000, maxBuffer: 256 * 1024 })
  return stdout
}

/**
 * Turns a registry command line into an argv for one file.
 *
 * The registry writes `"C:\...\app.exe" "%1"`, sometimes with extra switches, and `%1`/`%L` stand
 * for the file. Main resolves this itself from a fresh discovery instead of accepting a command
 * line from the renderer, so a stale or edited list cannot make the app start anything else.
 */
export function resolveOpenWithInvocation(
  command: string,
  filePath: string,
): { executable: string; args: string[] } | null {
  const parsed = splitCommandLine(command)
  if (!parsed) return null
  const rest = command.trim().slice(parsed.executable.length + (command.trim().startsWith('"') ? 2 : 0))
  const substituted = rest.replace(/%[1lLsS*]/gu, filePath)
  const args: string[] = []
  let current = ''
  let quoted = false
  for (const character of substituted) {
    if (character === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/u.test(character)) {
      if (current) args.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current) args.push(current)
  // A registry entry without a placeholder still expects the file as its argument.
  if (!/%[1lLsS*]/u.test(rest) && args.length === 0) args.push(filePath)
  return { executable: parsed.executable, args }
}
