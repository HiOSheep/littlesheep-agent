// Minimal `pnpm` stand-in for this checkout.
//
// The DSH runtime that used to provide a real pnpm shim moved, so the workspace
// scripts need a way to run `pnpm --filter <pkg> run <script>` with real Node.
// This translates the subset the build path uses into `npm run <script>` inside the
// matching workspace package (npm resolves that package's own .bin, which is where
// electron-vite/tsc live). Anything it does not understand fails loudly instead of
// silently doing nothing.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = process.argv[2]
const args = process.argv.slice(3)

function packageDirByName(name) {
  const packagesDir = join(repoRoot, 'packages')
  for (const entry of readdirSync(packagesDir)) {
    const manifest = join(packagesDir, entry, 'package.json')
    if (!existsSync(manifest)) continue
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    if (parsed.name === name) return join(packagesDir, entry)
  }
  if (name === 'littlesheep' || name === '@littlesheep/root') return repoRoot
  return null
}

function runNpmScript(directory, script, extra) {
  const invocation = process.platform === 'win32'
    ? { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm', 'run', script, ...(extra.length > 0 ? ['--', ...extra] : [])] }
    : { command: 'npm', args: ['run', script, ...(extra.length > 0 ? ['--', ...extra] : [])] }
  const result = spawnSync(invocation.command, invocation.args, { cwd: directory, stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  return result.status ?? 1
}

let filter = null
const rest = []
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--filter' || arg === '-F') {
    filter = args[index + 1] ?? null
    index += 1
    continue
  }
  if (arg.startsWith('--filter=')) {
    filter = arg.slice('--filter='.length)
    continue
  }
  if (arg === '--silent' || arg === '-s' || arg === '--stream') continue
  rest.push(arg)
}

if (rest[0] === 'run' && rest[1]) {
  const script = rest[1]
  const extra = rest.slice(2)
  const directories = filter
    ? filter.split(',').map((name) => packageDirByName(name.trim()))
    : [repoRoot]
  if (directories.some((directory) => directory === null)) {
    console.error(`pnpm-shim: unknown package filter ${filter}`)
    process.exit(1)
  }
  let status = 0
  for (const directory of directories) status = runNpmScript(directory, script, extra) || status
  process.exit(status)
}

if (rest[0] === 'exec' && rest[1]) {
  const command = rest.slice(1)
  const result = spawnSync(command[0], command.slice(1), { cwd: repoRoot, stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}

console.error(`pnpm-shim: unsupported invocation: ${args.join(' ')}`)
process.exit(1)
