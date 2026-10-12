import { copyFile, cp, mkdir, readFile, readdir, realpath, stat, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = join(repoRoot, 'packages', 'app')
const appRequire = createRequire(join(appRoot, 'package.json'))
const runtimeRoot = join(appRoot, 'runtime')
const force = process.argv.includes('--force')
/**
 * The prepared runtime is a copy of the installed Electron's `dist` with the
 * executable renamed, so the completeness check asks that `dist` which files
 * exist instead of naming them itself. The previous hardcoded manifest of every
 * DLL broke the moment the runtime moved: Electron 44 dropped the ANGLE pair
 * (`libEGL.dll`, `libGLESv2.dll`) and added `dxcompiler.dll` / `dxil.dll`, so the
 * check failed on a runtime that was in fact complete — and because `predev` and
 * `prebuild` both run this script, that surfaced as `pnpm run dev` exiting 1.
 *
 * `stableRuntimeEntries` is the weaker question the fallback path can ask: when
 * no installed Electron is reachable there is no `dist` to compare against, so
 * it verifies the entries the launcher dereferences by name.
 */
const stableRuntimeEntries = [
  ['version', 'file'],
  ['locales', 'directory'],
  ['resources', 'directory'],
  ['resources/default_app.asar', 'file'],
]

async function entryIs(path, type) {
  try {
    const entry = await stat(path)
    return type === 'file' ? entry.isFile() : entry.isDirectory()
  } catch {
    return false
  }
}

/**
 * `sourceDirectory` is the installed Electron's `dist` when it is known, and
 * `sourceBinaryName` is the executable that the renamed `LittleSheep.exe`
 * replaces inside the runtime — that one name is skipped. Every other entry has
 * to be present, and files have to match the source size.
 */
async function isCompleteRuntime(runtimeDirectory, runtimePath, sourceDirectory, sourceBinaryName, expectedBinarySize) {
  if (!(await entryIs(runtimePath, 'file'))) return false

  if (typeof expectedBinarySize === 'number') {
    try {
      if ((await stat(runtimePath)).size !== expectedBinarySize) return false
    } catch {
      return false
    }
  }

  if (sourceDirectory) {
    let entries
    try {
      entries = await readdir(sourceDirectory, { withFileTypes: true })
    } catch {
      return false
    }
    const mirrored = await Promise.all(entries
      .filter((entry) => entry.name !== sourceBinaryName)
      .map(async (entry) => {
        const source = join(sourceDirectory, entry.name)
        const target = join(runtimeDirectory, entry.name)
        if (entry.isDirectory()) return entryIs(target, 'directory')
        if (!(await entryIs(target, 'file'))) return false
        try {
          return (await stat(target)).size === (await stat(source)).size
        } catch {
          return false
        }
      }))
    return mirrored.every(Boolean)
  }

  const present = await Promise.all(
    stableRuntimeEntries.map(([relative, type]) => entryIs(join(runtimeDirectory, relative), type)),
  )
  return present.every(Boolean)
}

async function readElectronVersion(electronPackageRoot) {
  try {
    const packagePath = join(electronPackageRoot, 'package.json')
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
let electronPackageRoot
try {
  electronPackageRoot = await realpath(dirname(appRequire.resolve('electron/package.json')))
  electronPath = await realpath(resolve(String(appRequire('electron')).trim()))
} catch (error) {
  const prepared = process.platform === 'darwin' ? undefined : await findPreparedRuntime()
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
  const prepared = process.platform === 'darwin' ? undefined : await findPreparedRuntime()
  if (prepared) {
    console.log(prepared)
    process.exit(0)
  }
  throw new Error(`Electron executable was not found at ${electronPath}: ${error instanceof Error ? error.message : String(error)}`)
}
if (!source.isFile()) throw new Error(`Electron executable is not a file: ${electronPath}`)
const installedDistRoot = await realpath(join(electronPackageRoot, 'dist'))
const executableRelativeToDist = relative(installedDistRoot, electronPath)
if (executableRelativeToDist === '..'
  || executableRelativeToDist.startsWith(`..${sep}`)
  || isAbsolute(executableRelativeToDist)) {
  throw new Error(`Electron executable is outside the installed distribution: ${electronPath}`)
}

let electronRuntimePath
if (process.platform === 'darwin') {
  let appBundleRoot = dirname(electronPath)
  while (appBundleRoot !== dirname(appBundleRoot) && !basename(appBundleRoot).endsWith('.app')) {
    appBundleRoot = dirname(appBundleRoot)
  }
  if (!basename(appBundleRoot).endsWith('.app')) {
    throw new Error(`Electron executable is not inside a macOS .app bundle: ${electronPath}`)
  }
  const bundleExecutable = join(appBundleRoot, 'Contents', 'MacOS', basename(electronPath))
  if (resolve(bundleExecutable) !== electronPath) {
    throw new Error(`Electron executable is outside the expected macOS bundle location: ${electronPath}`)
  }
  const requiredBundleEntries = [
    ['Contents/Info.plist', 'file'],
    ['Contents/Frameworks', 'directory'],
    ['Contents/Resources', 'directory'],
  ]
  for (const [relativePath, type] of requiredBundleEntries) {
    if (!(await entryIs(join(appBundleRoot, relativePath), type))) {
      throw new Error(`Installed Electron .app bundle is incomplete: ${join(appBundleRoot, relativePath)}`)
    }
  }
  // Keep the installed bundle structure intact: do not flatten it or rename its internal
  // executable. electron-vite and the build fingerprint use this original path.
  electronRuntimePath = electronPath
} else {
  const sourceDirectory = dirname(electronPath)
  const sourceBinaryName = basename(electronPath)
  const electronVersion = await readElectronVersion(electronPackageRoot)
  const runtimeDirectoryName = `electron-v${electronVersion}-${process.platform}-${process.arch}`
  let runtimeDirectory = join(runtimeRoot, runtimeDirectoryName)
  electronRuntimePath = join(runtimeDirectory, `LittleSheep${extname(electronPath)}`)

  if (force || !(await isCompleteRuntime(runtimeDirectory, electronRuntimePath, sourceDirectory, sourceBinaryName, source.size))) {
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

  if (!(await isCompleteRuntime(runtimeDirectory, electronRuntimePath, sourceDirectory, sourceBinaryName, source.size))) {
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
}

console.log(electronRuntimePath)
