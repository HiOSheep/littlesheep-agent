import { copyFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = join(repoRoot, 'packages', 'app')
const appRequire = createRequire(join(appRoot, 'package.json'))
const electronPath = resolve(appRequire('electron'))
const electronRuntimePath = join(dirname(electronPath), `LittleSheep${extname(electronPath)}`)
const force = process.argv.includes('--force')

const source = await stat(electronPath)
let shouldCopy = force
try {
  const target = await stat(electronRuntimePath)
  shouldCopy ||= target.size !== source.size || target.mtimeMs < source.mtimeMs
} catch {
  shouldCopy = true
}

if (shouldCopy) {
  await copyFile(electronPath, electronRuntimePath)
}

console.log(electronRuntimePath)
