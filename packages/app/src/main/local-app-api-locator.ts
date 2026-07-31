import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const LOCAL_APP_API_LOCATOR_RELATIVE_PATH = join('runtime', 'local-app-api.json')

export interface LocalAppApiLocator {
  version: 1
  host: '127.0.0.1'
  port: number
  token: string
  pid: number
  startedAt: string
}

export function localAppApiLocatorPath(dataDir: string): string {
  return join(dataDir, LOCAL_APP_API_LOCATOR_RELATIVE_PATH)
}

export async function writeLocalAppApiLocator(
  dataDir: string,
  locator: LocalAppApiLocator,
): Promise<string> {
  const path = localAppApiLocatorPath(dataDir)
  const runtimeDir = join(dataDir, 'runtime')
  const temporaryPath = `${path}.${process.pid}.tmp`
  await mkdir(runtimeDir, { recursive: true })
  try {
    await writeFile(temporaryPath, `${JSON.stringify(locator, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  return path
}

export async function removeLocalAppApiLocator(dataDir: string, token: string): Promise<void> {
  const path = localAppApiLocatorPath(dataDir)
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<LocalAppApiLocator>
    if (parsed.token !== token) return
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
