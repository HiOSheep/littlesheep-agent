import { copyFile, cp, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = join(repoRoot, 'packages', 'app')
const appRequire = createRequire(join(appRoot, 'package.json'))
const runtimeRoot = join(appRoot, 'runtime')
const force = process.argv.includes('--force')
const runtimeFiles = [
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'd3dcompiler_47.dll',
  'ffmpeg.dll',
  'icudtl.dat',
  'libEGL.dll',
  'libGLESv2.dll',
  'resources.pak',
  'resources/default_app.asar',
  'snapshot_blob.bin',
  'v8_context_snapshot.bin',
  'version',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'vulkan-1.dll',
]
const runtimeDirectories = ['locales', 'resources']

async function isCompleteRuntime(runtimeDirectory, runtimePath, expectedBinarySize) {
  const requiredFiles = [runtimePath, ...runtimeFiles.map((file) => join(runtimeDirectory, file))]
  const filesPresent = await Promise.all(requiredFiles.map(async (path) => {
    try {
      const entry = await stat(path)
      return entry.isFile()
    } catch {
      return false
    }
  }))
  if (!filesPresent.every(Boolean)) return false

  const directoriesPresent = await Promise.all(runtimeDirectories.map(async (directory) => {
    try {
      return (await stat(join(runtimeDirectory, directory))).isDirectory()
    } catch {
      return false
    }
  }))
  if (!directoriesPresent.every(Boolean)) return false

  if (typeof expectedBinarySize === 'number') {
    try {
      if ((await stat(runtimePath)).size !== expectedBinarySize) return false
    } catch {
      return false
    }
  }
  return true
}

async function readElectronVersion(electronPath) {
  try {
    const packagePath = join(dirname(dirname(electronPath)), 'package.json')
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
    if (typeof packageJson.version === 'string' && packageJson.version.trim()) {
      return packageJson.version.trim()
    }
  } catch {
    // The package metadata is optional once a previously prepared runtime exists.
  }
  return 'unknown'
}

async function findPreparedRuntime() {
  try {
    const entries = await readdir(runtimeRoot, { withFileTypes: true })
    const candidates = entries
      .filter((entry) => entry.isDirectory()
        && !entry.name.startsWith('.')
        && entry.name.includes(`-${process.platform}-${process.arch}`))
      .map((entry) => join(runtimeRoot, entry.name))
      .sort()
      .reverse()
    for (const directory of candidates) {
      const path = join(directory, process.platform === 'win32' ? 'LittleSheep.exe' : 'LittleSheep')
      if (await isCompleteRuntime(directory, path)) return path
    }
  } catch {
    // No prepared runtime directory yet.
  }
  return undefined
}

let electronPath
try {
  electronPath = resolve(String(appRequire('electron')).trim())
} catch (error) {
  const prepared = await findPreparedRuntime()
  if (prepared) {
    console.log(prepared)
    process.exit(0)
  }
  throw new Error(`Unable to resolve the Electron runtime: ${error instanceof Error ? error.message : String(error)}`)
}

let source
try {
  source = await stat(electronPath)
} catch (error) {
  const prepared = await findPreparedRuntime()
  if (prepared) {
    console.log(prepared)
    process.exit(0)
  }
  throw new Error(`Electron executable was not found at ${electronPath}: ${error instanceof Error ? error.message : String(error)}`)
}
if (!source.isFile()) throw new Error(`Electron executable is not a file: ${electronPath}`)
const sourceDirectory = dirname(electronPath)
const sourceBinaryName = basename(electronPath)
const electronVersion = await readElectronVersion(electronPath)
const runtimeDirectoryName = `electron-v${electronVersion}-${process.platform}-${process.arch}`
let runtimeDirectory = join(runtimeRoot, runtimeDirectoryName)
let electronRuntimePath = join(runtimeDirectory, `LittleSheep${extname(electronPath)}`)

if (force || !(await isCompleteRuntime(runtimeDirectory, electronRuntimePath, source.size))) {
  // Keep each prepared runtime isolated. This avoids replacing DLLs that a
  // currently running LittleSheep process may still have open.
  if (await stat(runtimeDirectory).then(() => true).catch(() => false)) {
    runtimeDirectory = join(runtimeRoot, `${runtimeDirectoryName}-${Date.now()}`)
    electronRuntimePath = join(runtimeDirectory, `LittleSheep${extname(electronPath)}`)
  }
  await mkdir(runtimeDirectory, { recursive: true })
  await cp(sourceDirectory, runtimeDirectory, { recursive: true, force: true })
  if (sourceBinaryName !== basename(electronRuntimePath)) {
    // The stable runtime only needs the renamed executable. Keeping the
    // original electron.exe would duplicate a ~200 MB binary on Windows.
    await unlink(join(runtimeDirectory, sourceBinaryName)).catch(() => {})
    await copyFile(electronPath, electronRuntimePath)
  }
}

if (!(await isCompleteRuntime(runtimeDirectory, electronRuntimePath, source.size))) {
  throw new Error(`Prepared Electron runtime is incomplete at ${runtimeDirectory}`)
}
if (sourceBinaryName !== basename(electronRuntimePath)) {
  // Older preparations copied both names. Remove the redundant original when
  // it is not held open, while leaving a running process untouched.
  await unlink(join(runtimeDirectory, sourceBinaryName)).catch(() => {})
}

// Keep the package-local alias for electron-vite and existing diagnostics;
// the desktop shortcut itself points at the stable runtime directory above.
const packageRuntimePath = join(sourceDirectory, `LittleSheep${extname(electronPath)}`)
let packageRuntimeIsCurrent = false
try {
  const packageRuntime = await stat(packageRuntimePath)
  packageRuntimeIsCurrent = packageRuntime.isFile()
    && packageRuntime.size === source.size
    && packageRuntime.mtimeMs >= source.mtimeMs
} catch {
  packageRuntimeIsCurrent = false
}
if (force || !packageRuntimeIsCurrent) {
  try {
    await copyFile(electronPath, packageRuntimePath)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    const packageRuntimeExists = await stat(packageRuntimePath).then((entry) => entry.isFile()).catch(() => false)
    if (!packageRuntimeExists || !['EACCES', 'EBUSY', 'EPERM'].includes(code)) throw error
    // A running app can keep the package-local alias open. The stable runtime
    // is already valid, so leave the old alias in place and let the build continue.
    console.error(`Unable to refresh the package-local Electron alias (${code}); keeping the existing file.`)
  }
}

console.log(electronRuntimePath)
