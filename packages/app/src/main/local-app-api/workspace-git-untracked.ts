// Scans untracked files with fixed concurrency, byte budgets, and symlink-safe boundaries.

import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

const DEFAULT_MAX_CONCURRENCY = 4
const DEFAULT_MAX_FILES = 4_096
const DEFAULT_TOTAL_SCAN_BYTES = 32 * 1024 * 1024
const MAX_EXACT_COUNT_BYTES = 8 * 1024 * 1024
const SAMPLE_BYTES = 64 * 1024

export interface UntrackedFileCount {
  additions: number
  deletions: 0
  binary: boolean
  countAvailable: boolean
}

export interface UntrackedScanResult {
  counts: Map<string, UntrackedFileCount>
  limited: boolean
}

export async function countUntrackedFiles(
  repositoryRoot: string,
  repositoryPaths: string[],
  options: {
    maxConcurrency?: number
    maxFiles?: number
    maxScanBytes?: number
    signal?: AbortSignal
  } = {},
): Promise<UntrackedScanResult> {
  const maxConcurrency = positiveInteger(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY)
  const maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES)
  let remainingBytes = positiveInteger(options.maxScanBytes, DEFAULT_TOTAL_SCAN_BYTES)
  const selectedPaths = repositoryPaths.slice(0, maxFiles)
  const counts = new Map<string, UntrackedFileCount>()
  let nextIndex = 0
  let limited = repositoryPaths.length > selectedPaths.length
  const root = await realpath(repositoryRoot)

  async function worker(): Promise<void> {
    while (true) {
      throwIfAborted(options.signal)
      const index = nextIndex
      nextIndex += 1
      const repositoryPath = selectedPaths[index]
      if (repositoryPath === undefined) return
      const target = resolve(repositoryRoot, ...repositoryPath.split('/'))
      const inspected = await inspectCandidate(root, target, (requestedBytes) => {
        const reserved = Math.min(remainingBytes, requestedBytes)
        remainingBytes -= reserved
        return reserved
      }, options.signal)
      counts.set(repositoryPath, inspected)
      if (!inspected.countAvailable) limited = true
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(maxConcurrency, selectedPaths.length) },
    () => worker(),
  ))
  return { counts, limited }
}

export async function countUntrackedFile(
  repositoryRoot: string,
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<UntrackedFileCount> {
  const result = await countUntrackedFiles(repositoryRoot, [repositoryPath], { signal })
  return result.counts.get(repositoryPath) ?? unavailableCount()
}

async function inspectCandidate(
  realRoot: string,
  target: string,
  reserveBytes: (requestedBytes: number) => number,
  signal?: AbortSignal,
): Promise<UntrackedFileCount> {
  try {
    throwIfAborted(signal)
    const linkInfo = await lstat(target)
    if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) return unavailableCount()
    const canonicalTarget = await realpath(target)
    if (!isInsideOrSame(realRoot, canonicalTarget)) return unavailableCount()
    const info = await lstat(canonicalTarget)
    if (!info.isFile() || info.isSymbolicLink()) return unavailableCount()
    if (info.size === 0) return exactCount(0)
    const requestedBytes = info.size <= MAX_EXACT_COUNT_BYTES
      ? info.size
      : Math.min(info.size, SAMPLE_BYTES * 3)
    const reservedBytes = reserveBytes(requestedBytes)
    if (reservedBytes <= 0) return unavailableCount()
    return await inspectFile(canonicalTarget, info.size, reservedBytes, signal)
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    return unavailableCount()
  }
}

async function inspectFile(
  target: string,
  fileSize: number,
  reservedBytes: number,
  signal?: AbortSignal,
): Promise<UntrackedFileCount> {
  if (fileSize === 0) return exactCount(0)
  const handle = await open(target, 'r')
  const buffer = Buffer.allocUnsafe(Math.min(SAMPLE_BYTES, reservedBytes))
  try {
    const canCountExactly = fileSize <= MAX_EXACT_COUNT_BYTES && reservedBytes >= fileSize
    if (!canCountExactly) {
      const binary = await sampleForNullBytes(handle, buffer, fileSize, reservedBytes, signal)
      return { ...unavailableCount(), binary }
    }

    let offset = 0
    let additions = 1
    let lastByte: number | undefined
    while (offset < fileSize) {
      throwIfAborted(signal)
      const length = Math.min(buffer.length, fileSize - offset)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      if (bytesRead === 0) break
      const chunk = buffer.subarray(0, bytesRead)
      if (chunk.includes(0)) return { ...unavailableCount(), binary: true }
      for (const byte of chunk) if (byte === 0x0a) additions += 1
      lastByte = chunk[bytesRead - 1]
      offset += bytesRead
    }
    if (lastByte === 0x0a) additions -= 1
    return exactCount(additions)
  } finally {
    await handle.close()
  }
}

async function sampleForNullBytes(
  handle: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  fileSize: number,
  reservedBytes: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const offsets = [0, Math.max(0, Math.floor((fileSize - buffer.length) / 2)), Math.max(0, fileSize - buffer.length)]
  let remaining = reservedBytes
  for (const offset of [...new Set(offsets)]) {
    throwIfAborted(signal)
    if (remaining <= 0) break
    const length = Math.min(buffer.length, remaining, fileSize - offset)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    if (buffer.subarray(0, bytesRead).includes(0)) return true
    remaining -= bytesRead
  }
  return false
}

function exactCount(additions: number): UntrackedFileCount {
  return { additions, deletions: 0, binary: false, countAvailable: true }
}

function unavailableCount(): UntrackedFileCount {
  return { additions: 0, deletions: 0, binary: false, countAvailable: false }
}

function isInsideOrSame(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value as number : fallback
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('Untracked scan aborted.')
  error.name = 'AbortError'
  throw error
}
