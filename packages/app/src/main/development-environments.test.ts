import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DevelopmentEnvironmentManager } from './development-environments'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('DevelopmentEnvironmentManager', () => {
  it('exposes Electron Node as an LS-owned runtime and creates a terminal shim', async () => {
    const dataDir = await createDataDir()
    const manager = new DevelopmentEnvironmentManager({ dataDir, electronExecutable: process.execPath })
    const snapshot = await manager.snapshot(true)
    const node = snapshot.environments.find((environment) => environment.id === 'node')

    expect(node).toMatchObject({ source: 'builtin', state: 'ready' })
    expect(node?.currentVersion).toMatch(/^v?\d+\.\d+/u)
    expect(existsSync(join(dataDir, 'toolchains', 'node', 'bin', process.platform === 'win32' ? 'node.cmd' : 'node'))).toBe(true)
  })

  it('persists user-selected target versions without changing process.env', async () => {
    const dataDir = await createDataDir()
    const originalPath = process.env.PATH
    const manager = new DevelopmentEnvironmentManager({ dataDir, electronExecutable: process.execPath })
    const snapshot = await manager.setVersion('python', '3.12')
    const python = snapshot.environments.find((environment) => environment.id === 'python')
    const preferences = JSON.parse(await readFile(join(dataDir, 'toolchains', 'preferences.json'), 'utf8')) as {
      versions: Record<string, string>
    }

    expect(python?.requestedVersion).toBe('3.12')
    expect(preferences.versions.python).toBe('3.12')
    const terminalEnvironment = await manager.terminalEnvironment()
    const pathKey = Object.keys(terminalEnvironment).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
    expect(terminalEnvironment[pathKey]?.split(delimiter)[0]).toBe(join(dataDir, 'toolchains', 'node', 'bin'))
    expect(process.env.PATH).toBe(originalPath)
  })

  it('serializes preference writes and rejects path-like version labels', async () => {
    const dataDir = await createDataDir()
    const manager = new DevelopmentEnvironmentManager({ dataDir, electronExecutable: process.execPath })

    await expect(manager.setVersion('python', '../escape')).rejects.toThrow('invalid development environment version')
    await Promise.all([
      manager.setVersion('python', '3.12'),
      manager.setVersion('go', '1.23'),
    ])

    const preferences = JSON.parse(await readFile(join(dataDir, 'toolchains', 'preferences.json'), 'utf8')) as {
      versions: Record<string, string>
    }
    expect(preferences.versions).toMatchObject({ python: '3.12', go: '1.23' })
    expect(existsSync(join(dataDir, 'escape'))).toBe(false)
  })

  it('does not silently activate a different managed version when the requested one is absent', async () => {
    const dataDir = await createDataDir()
    await mkdir(join(dataDir, 'toolchains', 'python', '3.12'), { recursive: true })
    const manager = new DevelopmentEnvironmentManager({ dataDir, electronExecutable: process.execPath })

    const snapshot = await manager.setVersion('python', '3.13')
    const python = snapshot.environments.find((environment) => environment.id === 'python')
    expect(python?.requestedVersion).toBe('3.13')
    expect(python?.availableVersions).toContain('3.12')
    expect(python?.activeManagedVersion).toBeNull()
    expect(python?.source).not.toBe('managed')
  })

  it('imports, verifies and activates an extracted runtime', async () => {
    const dataDir = await createDataDir()
    const source = await mkdtemp(join(tmpdir(), 'ls-toolchain-source-'))
    directories.push(source)
    const executable = join(source, process.platform === 'win32' ? 'node.exe' : 'node')
    await copyFile(process.execPath, executable)
    if (process.platform !== 'win32') await chmod(executable, 0o755)
    const detectedVersion = process.version.replace(/^v/u, '')

    const manager = new DevelopmentEnvironmentManager({
      dataDir,
      electronExecutable: process.execPath,
      platform: process.platform,
      baseEnvironment: { PATH: process.env.PATH ?? '' },
    })
    const snapshot = await manager.importVersion('node', detectedVersion, source)
    const node = snapshot.environments.find((environment) => environment.id === 'node')

    expect(node).toMatchObject({ source: 'managed', state: 'ready', activeManagedVersion: detectedVersion })
    expect(node?.requestedVersion).toBe(detectedVersion)
    expect(existsSync(join(dataDir, 'toolchains', 'node', detectedVersion, process.platform === 'win32' ? 'node.exe' : 'node'))).toBe(true)
  })

  it('keeps a version-series preference while activating the detected patch release', async () => {
    const dataDir = await createDataDir()
    const source = await mkdtemp(join(tmpdir(), 'ls-node-toolchain-source-'))
    directories.push(source)
    const executable = join(source, process.platform === 'win32' ? 'node.exe' : 'node')
    await copyFile(process.execPath, executable)
    if (process.platform !== 'win32') await chmod(executable, 0o755)
    const detectedVersion = process.version.replace(/^v/u, '')
    const [major, minor] = detectedVersion.split('.')
    const versionSeries = `${major}.${minor}`

    const manager = new DevelopmentEnvironmentManager({
      dataDir,
      electronExecutable: process.execPath,
      platform: process.platform,
      baseEnvironment: { PATH: process.env.PATH ?? '' },
    })
    const imported = await manager.importVersion('node', versionSeries, source)
    const node = imported.environments.find((environment) => environment.id === 'node')

    expect(node).toMatchObject({
      source: 'managed',
      state: 'ready',
      activeManagedVersion: detectedVersion,
      requestedVersion: versionSeries,
    })
    expect(existsSync(join(dataDir, 'toolchains', 'node', detectedVersion, process.platform === 'win32' ? 'node.exe' : 'node'))).toBe(true)

    const removed = await manager.removeVersion('node', detectedVersion)
    expect(removed.environments.find((environment) => environment.id === 'node')?.requestedVersion).toBeNull()
  })
})

async function createDataDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ls-development-environments-'))
  directories.push(path)
  return path
}
