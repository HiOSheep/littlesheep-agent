// Discovers repository-configured executable filters so review commands can neutralize them.

import {
  runReadOnlyGit,
  type GitConfigOverride,
} from './workspace-git-command.js'

const EXECUTABLE_FILTER_CONFIG_PATTERN = '^filter\\..*\\.(clean|process)$'
const MAX_EXECUTABLE_FILTER_CONFIG_BYTES = 64 * 1024
const MAX_EXECUTABLE_FILTER_DRIVERS = 32
const MAX_FILTER_DRIVER_NAME_CHARS = 256
const MAX_TOTAL_FILTER_DRIVER_CHARS = 2_048

export async function readDisabledFilterOverrides(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<GitConfigOverride[]> {
  const result = await runReadOnlyGit(repositoryRoot, [
    'config',
    '--null',
    '--name-only',
    '--get-regexp',
    EXECUTABLE_FILTER_CONFIG_PATTERN,
  ], {
    allowExitCodes: [0, 1],
    maxBytes: MAX_EXECUTABLE_FILTER_CONFIG_BYTES,
    signal,
  })
  if (result.code !== 0) return []

  const drivers = new Set<string>()
  let totalDriverChars = 0
  for (const key of result.stdout.toString('utf8').split('\0')) {
    const driver = key.replace(/\.(?:clean|process)$/u, '')
    if (driver === key || !driver.startsWith('filter.') || drivers.has(driver)) continue
    if (
      drivers.size >= MAX_EXECUTABLE_FILTER_DRIVERS
      || driver.length > MAX_FILTER_DRIVER_NAME_CHARS
      || totalDriverChars + driver.length > MAX_TOTAL_FILTER_DRIVER_CHARS
    ) {
      throw new Error('Repository executable Git filter configuration exceeds the safe review limit.')
    }
    drivers.add(driver)
    totalDriverChars += driver.length
  }
  return [...drivers]
    .sort()
    .flatMap((driver): GitConfigOverride[] => [
      [`${driver}.clean`, ''],
      [`${driver}.process`, ''],
      [`${driver}.required`, 'false'],
    ])
}
