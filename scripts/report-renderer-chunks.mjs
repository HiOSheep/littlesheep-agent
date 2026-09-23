// Report what the renderer entry chunk is made of, by running the real build
// with an extra reporting plugin.
//
// Source-level import reading cannot answer this: Vite hoists every statically
// reachable module into the entry chunk and splits only what is dynamically
// imported, so the ownership of each kilobyte is only visible in the bundle
// graph. CS-05 uses this to decide what is worth deferring instead of guessing.
//
// Usage:
//   node scripts/report-renderer-chunks.mjs [--out=renderer-module-report.json]
//
// It temporarily adds a reporting plugin to `packages/app/electron.vite.config.ts`,
// builds, and restores the config. The renderer output lands in the normal
// `packages/app/out`, so re-run `pnpm run build:app` afterwards if the build
// fingerprint needs to settle.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = process.cwd()
const configPath = join(repoRoot, 'packages/app/electron.vite.config.ts')
const outPath = join(repoRoot, (process.argv.find((argument) => argument.startsWith('--out=')) ?? '--out=renderer-module-report.json').slice('--out='.length))

const PLUGIN_MARKER = 'rendererModuleReport()'
const PLUGIN_SOURCE = `
function rendererModuleReport() {
  return {
    name: 'renderer-module-report',
    generateBundle(_options: unknown, bundle: Record<string, unknown>) {
      const chunks = Object.entries(bundle)
        .filter(([, output]) => output && typeof output === 'object' && (output as { type?: string }).type === 'chunk')
        .map(([file, output]) => {
          const chunk = output as { code: string; modules: Record<string, { renderedLength: number }> }
          const modules = Object.entries(chunk.modules)
            .map(([id, info]) => ({ id: id.replace(process.cwd(), '').replaceAll('\\\\', '/'), bytes: info.renderedLength }))
          return { file, bytes: chunk.code.length, moduleCount: modules.length, totalModuleBytes: modules.reduce((sum, item) => sum + item.bytes, 0), topModules: [...modules].sort((left, right) => right.bytes - left.bytes).slice(0, 40) }
        })
        .sort((left, right) => right.bytes - left.bytes)
      writeFileSync(resolve(__dirname, '..', '..', ${JSON.stringify(outPath.replace(`${repoRoot}\\`, '').replaceAll('\\', '/'))}), \`\${JSON.stringify(chunks, null, 2)}\\n\`, 'utf8')
      console.log('[renderer-module-report] wrote ' + chunks.length + ' chunks')
    },
  }
}
`

const original = await readFile(configPath, 'utf8')
if (!original.includes('writeFileSync')) {
  await writeFile(configPath, original.replace("import { existsSync, readFileSync } from 'node:fs'", "import { existsSync, readFileSync, writeFileSync } from 'node:fs'"), 'utf8')
}
const withPlugin = (await readFile(configPath, 'utf8'))
  .replace('      rejectMonacoLanguageWorkers(),\n', `      rejectMonacoLanguageWorkers(),\n      ${PLUGIN_MARKER},\n`)
  .replace('function rejectMonacoLanguageWorkers() {', `${PLUGIN_SOURCE}\nfunction rejectMonacoLanguageWorkers() {`)
await writeFile(configPath, withPlugin, 'utf8')

try {
  const result = spawnSync('pnpm', ['run', 'build:app'], { cwd: repoRoot, stdio: 'inherit', shell: true })
  if (result.status !== 0) throw new Error(`build failed with status ${result.status}`)
} finally {
  await writeFile(configPath, original, 'utf8')
}

const report = JSON.parse(await readFile(outPath, 'utf8'))
const entry = report.find((chunk) => /^assets\/index-/u.test(chunk.file)) ?? report[0]
const byArea = new Map()
for (const module of entry.topModules) {
  const id = module.id
  const area = id.includes('/renderer/workspace/') ? 'renderer/workspace'
    : id.includes('/renderer/settings/') ? 'renderer/settings'
      : id.includes('/renderer/chat/') ? 'renderer/chat'
        : id.includes('/renderer/app-shell/') ? 'renderer/app-shell'
          : id.includes('/renderer/sidebar/') ? 'renderer/sidebar'
            : id.includes('/renderer/') ? 'renderer/other'
              : 'node_modules'
  byArea.set(area, (byArea.get(area) ?? 0) + module.bytes)
}
console.log(JSON.stringify({
  report: outPath,
  entry: { file: entry.file, bytes: entry.bytes, moduleCount: entry.moduleCount },
  topAreasOfEntry: [...byArea.entries()].sort((left, right) => right[1] - left[1]).map(([area, bytes]) => ({ area, bytes })),
  topModules: entry.topModules.slice(0, 12),
}, null, 2))
