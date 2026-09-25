// Bounded loopback static file service for *running* workspace HTML pages.
//
// The static preview never executes page scripts, so an HTML game has to be
// served the way a browser serves it: over HTTP, from its own directory, with
// relative CSS / images / modules / fetch all working. This service is
// deliberately small and is the only place that answers those requests.
//
// Boundaries it must keep:
//   - one listener per workspace root, bound to 127.0.0.1 with an ephemeral port;
//   - every request carries a per-server random token, so another local page
//     cannot guess the prefix;
//   - only regular files inside that root are answered, resolved through
//     `realpath`, so `..`, encoded traversal and symlinks cannot escape;
//   - no directory listing, no method other than GET/HEAD, no CORS headers, and
//     a `Host` check against loopback so a rebound DNS name cannot reach it;
//   - a bounded number of servers, an idle timeout and an explicit stop.

import { randomBytes } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { extname, join, posix, relative, resolve, sep } from 'node:path'
import { HttpError } from './http.js'
import { isPathInsideOrSame } from './workspace-support.js'

export const MAX_WORKSPACE_PREVIEW_SERVERS = 4
export const MAX_WORKSPACE_PREVIEW_FILE_BYTES = 32 * 1024 * 1024
export const WORKSPACE_PREVIEW_IDLE_TIMEOUT_MS = 30 * 60 * 1000

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon', '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.wav': 'audio/wav',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
}

export interface WorkspacePreviewServerInfo {
  /** Workspace root this server is scoped to. */
  root: string
  /** Loopback URL of the entry document, including the access token. */
  url: string
  /** Request path of the entry document relative to the root. */
  entry: string
  startedAt: string
  requests: number
}

interface PreviewServerEntry {
  root: string
  realRoot: string
  token: string
  server: Server
  origin: string
  entry: string
  startedAt: string
  requests: number
  lastRequestAt: number
}

export class WorkspacePreviewServers {
  private readonly entries = new Map<string, PreviewServerEntry>()
  private sweeping: ReturnType<typeof setInterval> | undefined

  async start(root: string, entryPath: string): Promise<WorkspacePreviewServerInfo> {
    const realRoot = await realpath(root).catch(() => {
      throw new HttpError(400, 'workspace root is not a directory')
    })
    const entry = await resolveEntry(realRoot, entryPath)
    const key = comparablePath(realRoot)
    const existing = this.entries.get(key)
    if (existing) {
      existing.entry = entry
      existing.lastRequestAt = Date.now()
      return info(existing)
    }
    await this.evictOldestIfFull()
    const token = randomBytes(16).toString('hex')
    let created: PreviewServerEntry | undefined
    const server = createServer((req, res) => {
      void this.handle(created, req, res)
    })
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolvePromise())
    })
    server.on('error', (error) => {
      console.error(`[workspace-preview-server] listener error: ${(error as Error).message}`)
    })
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    created = {
      root,
      realRoot,
      token,
      server,
      origin: `http://127.0.0.1:${port}`,
      entry,
      startedAt: new Date().toISOString(),
      requests: 0,
      lastRequestAt: Date.now(),
    }
    this.entries.set(key, created)
    this.ensureSweeper()
    return info(created)
  }

  async stop(root: string): Promise<{ stopped: boolean }> {
    const key = comparablePath(await realpath(root).catch(() => root))
    const entry = this.entries.get(key)
    if (!entry) return { stopped: false }
    this.entries.delete(key)
    await closeServer(entry.server)
    if (this.entries.size === 0) this.clearSweeper()
    return { stopped: true }
  }

  async stopAll(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    this.clearSweeper()
    await Promise.all(entries.map((entry) => closeServer(entry.server)))
  }

  list(): WorkspacePreviewServerInfo[] {
    return [...this.entries.values()].map(info)
  }

  private async evictOldestIfFull(): Promise<void> {
    while (this.entries.size >= MAX_WORKSPACE_PREVIEW_SERVERS) {
      const oldest = [...this.entries.values()].sort((a, b) => a.lastRequestAt - b.lastRequestAt)[0]
      if (!oldest) return
      this.entries.delete(comparablePath(oldest.realRoot))
      await closeServer(oldest.server)
    }
  }

  private ensureSweeper(): void {
    this.sweeping ??= setInterval(() => {
      const now = Date.now()
      for (const [key, entry] of [...this.entries]) {
        if (now - entry.lastRequestAt < WORKSPACE_PREVIEW_IDLE_TIMEOUT_MS) continue
        this.entries.delete(key)
        void closeServer(entry.server)
      }
      if (this.entries.size === 0) this.clearSweeper()
    }, 60_000)
    this.sweeping.unref?.()
  }

  private clearSweeper(): void {
    if (!this.sweeping) return
    clearInterval(this.sweeping)
    this.sweeping = undefined
  }

  private async handle(entry: PreviewServerEntry | undefined, req: IncomingMessageLike, res: ServerResponseLike): Promise<void> {
    if (!entry || !isLoopbackHost(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }).end('method not allowed')
      return
    }
    const requested = parseRequestPath(req.url ?? '/', entry.token)
    if (requested === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
      return
    }
    entry.lastRequestAt = Date.now()
    entry.requests += 1
    try {
      const file = await resolveServedFile(entry.realRoot, requested)
      const info = await stat(file)
      if (!info.isFile()) throw new HttpError(404, 'not found')
      if (info.size > MAX_WORKSPACE_PREVIEW_FILE_BYTES) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' }).end('file is too large to serve')
        return
      }
      const body = await readFile(file)
      res.writeHead(200, {
        'content-type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(body.byteLength),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      if (req.method === 'HEAD') res.end()
      else res.end(body)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 404
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(status === 403 ? 'forbidden' : 'not found')
    }
  }
}

interface IncomingMessageLike {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
}

interface ServerResponseLike {
  writeHead(status: number, headers?: Record<string, string>): ServerResponseLike
  end(body?: string | Uint8Array): void
}

async function resolveEntry(realRoot: string, entryPath: string): Promise<string> {
  const target = resolve(realRoot, entryPath)
  if (!isPathInsideOrSame(realRoot, target)) {
    throw new HttpError(403, 'preview entry is outside the selected workspace')
  }
  const info = await stat(target).catch(() => undefined)
  if (!info?.isFile()) throw new HttpError(400, 'preview entry is not a file')
  // The advertised entry is the real file too, so a symlink out of the workspace
  // is rejected before the URL exists.
  const real = await assertInside(realRoot, target)
  return toPosix(relative(realRoot, real))
}

/** The request must carry the token prefix and stay inside the root. */
export function parseRequestPath(rawUrl: string, token: string): string | null {
  const withoutQuery = rawUrl.split(/[?#]/u, 1)[0] ?? ''
  let decoded: string
  try {
    decoded = decodeURIComponent(withoutQuery)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const segments = decoded.split('/').filter((segment) => segment.length > 0)
  if (segments[0] !== token) return null
  const rest = segments.slice(1)
  if (rest.some((segment) => segment === '..' || segment === '.')) return null
  if (rest.length === 0) return ''
  return rest.join('/')
}

async function resolveServedFile(realRoot: string, requestPath: string): Promise<string> {
  const candidate = resolve(realRoot, requestPath)
  if (!isPathInsideOrSame(realRoot, candidate)) throw new HttpError(403, 'path is outside the preview root')
  const info = await stat(candidate).catch(() => undefined)
  if (info?.isDirectory()) {
    // A directory is only ever served through its own index.html; there is no listing.
    const index = join(candidate, 'index.html')
    const indexInfo = await stat(index).catch(() => undefined)
    if (!indexInfo?.isFile()) throw new HttpError(404, 'not found')
    return assertInside(realRoot, index)
  }
  return assertInside(realRoot, candidate)
}

/** `realpath` again so a symlinked file cannot leave the workspace. */
async function assertInside(realRoot: string, candidate: string): Promise<string> {
  const real = await realpath(candidate).catch(() => {
    throw new HttpError(404, 'not found')
  })
  if (!isPathInsideOrSame(realRoot, real)) throw new HttpError(403, 'path is outside the preview root')
  return real
}

function isLoopbackHost(host: string | string[] | undefined): boolean {
  const value = Array.isArray(host) ? host[0] : host
  if (!value) return false
  const [name, port] = value.split(':')
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes((name ?? '').toLowerCase())) return false
  return port === undefined || /^\d+$/u.test(port)
}

function info(entry: PreviewServerEntry): WorkspacePreviewServerInfo {
  return {
    root: entry.root,
    url: `${entry.origin}/${entry.token}/${entry.entry}`,
    entry: entry.entry,
    startedAt: entry.startedAt,
    requests: entry.requests,
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()))
}

function comparablePath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, '')
  return /^[a-z]:[\\/]/iu.test(trimmed) || trimmed.startsWith('\\\\')
    ? trimmed.replace(/\//gu, '\\').toLocaleLowerCase('en-US')
    : trimmed
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join(posix.sep)
}
