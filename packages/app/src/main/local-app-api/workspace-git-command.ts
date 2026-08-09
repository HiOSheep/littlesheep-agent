// Read-only, bounded Git command runner used exclusively by workspace review.

import { spawn } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

const GIT_COMMAND_TIMEOUT_MS = 15_000
const MAX_GIT_METADATA_BYTES = 4 * 1024 * 1024
const MAX_STDERR_BYTES = 128 * 1024
export const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'

const REPOSITORY_TARGETING_GIT_ENVIRONMENT = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_GRAFT_FILE',
  'GIT_ICASE_PATHSPECS',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_INDEX_VERSION',
  'GIT_LITERAL_PATHSPECS',
  'GIT_NAMESPACE',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_SUPER_PREFIX',
  'GIT_WORK_TREE',
])
const CONTROLLED_GIT_ENVIRONMENT = new Set([
  'GIT_ASKPASS',
  'GIT_NO_LAZY_FETCH',
  'GIT_OPTIONAL_LOCKS',
  'GIT_PAGER',
  'GIT_TERMINAL_PROMPT',
  'LC_ALL',
  'SSH_ASKPASS',
])

let resolvedGitExecutable: string | null | undefined

export interface GitCommandResult {
  code: number | null
  stdout: Buffer
  stderr: string
  truncated: boolean
}

export type GitConfigOverride = readonly [key: string, value: string]

export function emptyGitResult(): GitCommandResult {
  return { code: 0, stdout: Buffer.alloc(0), stderr: '', truncated: false }
}

export function isGitUnavailable(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export function runReadOnlyGit(
  cwd: string,
  args: string[],
  options: {
    allowExitCodes?: number[]
    maxBytes?: number
    allowTruncated?: boolean
    configOverrides?: readonly GitConfigOverride[]
    signal?: AbortSignal
  } = {},
): Promise<GitCommandResult> {
  const allowExitCodes = options.allowExitCodes ?? [0]
  const maxBytes = options.maxBytes ?? MAX_GIT_METADATA_BYTES
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      reject(abortError())
      return
    }
    const gitExecutable = trustedGitExecutable()
    if (!gitExecutable) {
      reject(gitUnavailableError())
      return
    }
    const configOverrides: readonly GitConfigOverride[] = [
      ['core.hooksPath', GIT_NULL_DEVICE],
      ['core.fsmonitor', 'false'],
      ...(options.configOverrides ?? []),
    ]
    const child = spawn(gitExecutable, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnvironment(configOverrides),
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let timedOut = false
    let aborted = false
    const handleAbort = () => {
      aborted = true
      child.kill()
    }
    options.signal?.addEventListener('abort', handleAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, GIT_COMMAND_TIMEOUT_MS)
    timer.unref?.()

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return
      const remaining = maxBytes - stdoutBytes
      if (chunk.length <= remaining) {
        stdoutChunks.push(chunk)
        stdoutBytes += chunk.length
        return
      }
      if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining))
      stdoutBytes = maxBytes
      truncated = true
      child.kill()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = MAX_STDERR_BYTES - stderrBytes
      if (remaining <= 0) return
      stderrChunks.push(chunk.subarray(0, remaining))
      stderrBytes += Math.min(chunk.length, remaining)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', handleAbort)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', handleAbort)
      const result: GitCommandResult = {
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
        truncated,
      }
      if (timedOut) {
        reject(new Error('Git command timed out.'))
        return
      }
      if (aborted) {
        reject(abortError())
        return
      }
      if (truncated && options.allowTruncated) {
        resolvePromise(result)
        return
      }
      if (truncated) {
        reject(new Error('Git metadata exceeded the bounded output limit.'))
        return
      }
      if (!allowExitCodes.includes(code ?? -1)) {
        reject(new Error(result.stderr || `Git command failed with exit code ${code ?? 'unknown'}.`))
        return
      }
      resolvePromise(result)
    })
  })
}

function gitEnvironment(configOverrides: readonly GitConfigOverride[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    const normalizedKey = key.toUpperCase()
    if (
      REPOSITORY_TARGETING_GIT_ENVIRONMENT.has(normalizedKey)
      || CONTROLLED_GIT_ENVIRONMENT.has(normalizedKey)
      || normalizedKey === 'GIT_CONFIG_COUNT'
      || normalizedKey === 'GIT_CONFIG_PARAMETERS'
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(normalizedKey)
      || normalizedKey.startsWith('GIT_TRACE')
      || normalizedKey === 'GIT_CURL_VERBOSE'
      || normalizedKey === 'GIT_REDIRECT_STDERR'
    ) {
      delete env[key]
    }
  }
  Object.assign(env, {
    GIT_ASKPASS: '',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    SSH_ASKPASS: '',
  })
  env.GIT_CONFIG_COUNT = String(configOverrides.length)
  configOverrides.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return env
}

function trustedGitExecutable(): string | null {
  if (resolvedGitExecutable !== undefined) return resolvedGitExecutable
  resolvedGitExecutable = resolveGitExecutable()
  return resolvedGitExecutable
}

function resolveGitExecutable(): string | null {
  const executableNames = process.platform === 'win32' ? ['git.exe'] : ['git']
  for (const rawEntry of (process.env.PATH ?? '').split(delimiter)) {
    const entry = unquotePathEntry(rawEntry.trim())
    if (!entry || !isAbsolute(entry)) continue
    for (const executableName of executableNames) {
      const candidate = join(entry, executableName)
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, constants.X_OK)
        return realpathSync(candidate)
      } catch {
        // Continue to the next absolute PATH entry.
      }
    }
  }
  return null
}

function unquotePathEntry(entry: string): string {
  if (entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')) {
    return entry.slice(1, -1)
  }
  return entry
}

function gitUnavailableError(): NodeJS.ErrnoException {
  const error = new Error('Git executable was not found in an absolute PATH entry.') as NodeJS.ErrnoException
  error.code = 'ENOENT'
  error.path = 'git'
  error.syscall = 'spawn'
  return error
}

function abortError(): Error {
  const error = new Error('Git command aborted.')
  error.name = 'AbortError'
  return error
}
