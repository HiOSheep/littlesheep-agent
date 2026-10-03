// @littlesheep/app - executable-descriptions.ts
// The display name of an executable, for the menus that list applications.
//
// The registry only sometimes carries a `FriendlyAppName`, and the entries that come from a ProgId
// never do, so those rows fell back to the file name: the open-with menu read `msedge`, `chrome`,
// `iexplore` while Explorer calls the same programs Microsoft Edge, Google Chrome and Internet
// Explorer (reported 2026-10-03). Windows keeps that name in the executable's own version resource
// (`FileDescription`), which is what Explorer and the task switcher show.
//
// One PowerShell process reads the whole list: spawning one per file would cost more than the menu
// is worth. Cached, best-effort, and empty on anything unexpected - the caller keeps the file name
// as its last resort, and a name the console codepage garbled is dropped there rather than shown.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const cache = new Map<string, string>()

export async function describeExecutables(paths: string[]): Promise<Map<string, string>> {
  const described = new Map<string, string>()
  if (process.platform !== 'win32' || paths.length === 0) return described
  const missing: string[] = []
  for (const path of paths) {
    const cached = cache.get(path.toLowerCase())
    if (cached === undefined) missing.push(path)
    else if (cached) described.set(path, cached)
  }
  if (missing.length === 0) return described
  const read = await readVersionDescriptions(missing)
  for (const path of missing) {
    const description = read.get(path.toLowerCase()) ?? ''
    cache.set(path.toLowerCase(), description)
    if (description) described.set(path, description)
  }
  return described
}

async function readVersionDescriptions(paths: string[]): Promise<Map<string, string>> {
  const list = paths.map((path) => `'${path.replace(/'/gu, "''")}'`).join(', ')
  const script = [
    // UTF-8 out, so a non-ASCII description survives the pipe instead of arriving as mojibake.
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$ErrorActionPreference = "SilentlyContinue"',
    `foreach ($p in @(${list})) {`,
    '  $d = (Get-Item -LiteralPath $p).VersionInfo.FileDescription',
    '  if ($d) { Write-Output ($p + [char]9 + $d) }',
    '}',
  ].join('; ')
  try {
    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 },
    )
    return parseVersionDescriptions(stdout)
  } catch {
    return new Map()
  }
}

/** `C:\path\app.exe<TAB>Microsoft Edge` per line; anything else is ignored rather than guessed. */
export function parseVersionDescriptions(output: string): Map<string, string> {
  const descriptions = new Map<string, string>()
  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf('\t')
    if (separator <= 0) continue
    const path = line.slice(0, separator).trim()
    const description = line.slice(separator + 1).trim()
    if (path && description) descriptions.set(path.toLowerCase(), description)
  }
  return descriptions
}
