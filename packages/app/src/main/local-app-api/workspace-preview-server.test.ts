import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_WORKSPACE_PREVIEW_SERVERS,
  WorkspacePreviewServers,
  parseRequestPath,
} from './workspace-preview-server.js'

const roots: string[] = []
let servers: WorkspacePreviewServers | undefined

/** A raw GET with an explicit Host header (fetch forbids setting one). */
function rawStatus(url: string, host: string): Promise<number> {
  const target = new URL(url)
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { host },
    }, (response) => {
      response.resume()
      resolvePromise(response.statusCode ?? 0)
    })
    request.on('error', reject)
    request.end()
  })
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-preview-server-'))
  roots.push(root)
  return root
}

function service(): WorkspacePreviewServers {
  servers ??= new WorkspacePreviewServers()
  return servers
}

afterEach(async () => {
  await servers?.stopAll()
  servers = undefined
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('workspace preview server', () => {
  it('serves a workspace file over a tokenised loopback URL', async () => {
    const root = await fixtureRoot()
    await writeFile(join(root, 'game.html'), '<h1>game</h1>', 'utf8')
    await writeFile(join(root, 'game.css'), 'body{background:#123456}', 'utf8')

    const started = await service().start(root, join(root, 'game.html'))
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/game\.html$/u)

    const page = await fetch(started.url)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await page.text()).toBe('<h1>game</h1>')

    const css = await fetch(new URL('game.css', started.url))
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await css.text()).toBe('body{background:#123456}')
  })

  it('answers a directory request with its index.html and never lists files', async () => {
    const root = await fixtureRoot()
    await mkdir(join(root, 'game'), { recursive: true })
    await writeFile(join(root, 'game', 'index.html'), 'index', 'utf8')
    await writeFile(join(root, 'game', 'secret.txt'), 'secret', 'utf8')

    const started = await service().start(root, join(root, 'game', 'index.html'))
    const index = await fetch(started.url)
    expect(index.status).toBe(200)
    expect(await index.text()).toBe('index')

    const listing = await fetch(`${started.url.slice(0, started.url.lastIndexOf('/'))}/`)
    const listingBody = await listing.text()
    expect(listing.status).toBe(200)
    expect(listingBody).toBe('index')
    expect(listingBody).not.toContain('secret')
  })

  it('refuses requests without the token and any encoded traversal', async () => {
    const root = await fixtureRoot()
    await writeFile(join(root, 'game.html'), 'game', 'utf8')
    await writeFile(join(root, '..', 'outside.txt'), 'outside', 'utf8')

    const started = await service().start(root, join(root, 'game.html'))
    expect((await fetch(`http://127.0.0.1:${new URL(started.url).port}/game.html`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${new URL(started.url).port}/deadbeef/game.html`)).status).toBe(404)
    expect((await fetch(`${started.url.slice(0, started.url.lastIndexOf('/'))}/..%2Foutside.txt`)).status).toBe(404)
    expect((await fetch(`${started.url.slice(0, started.url.lastIndexOf('/'))}/%2e%2e%2foutside.txt`)).status).toBe(404)
  })

  it('refuses a symlink that leaves the workspace root', async () => {
    const root = await fixtureRoot()
    const outside = await fixtureRoot()
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8')
    await writeFile(join(root, 'game.html'), 'game', 'utf8')
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt')).catch(() => undefined)

    const started = await service().start(root, join(root, 'game.html'))
    const linked = await fetch(new URL('link.txt', started.url))
    expect([403, 404]).toContain(linked.status)
    await expect(service().start(root, join(root, 'link.txt'))).rejects.toThrow()
  })

  it('only accepts GET and HEAD from a loopback Host', async () => {
    const root = await fixtureRoot()
    await writeFile(join(root, 'game.html'), 'game', 'utf8')
    const started = await service().start(root, join(root, 'game.html'))

    expect((await fetch(started.url, { method: 'POST' })).status).toBe(405)
    // `fetch` refuses to send a custom Host header, so the rebinding probe uses a
    // raw request: a DNS name that resolves to 127.0.0.1 must not reach the files.
    expect(await rawStatus(started.url, 'evil.example')).toBe(403)
    expect(await rawStatus(started.url, new URL(started.url).host)).toBe(200)
  })

  it('stops a server on request and evicts the oldest when full', async () => {
    const started: string[] = []
    for (let index = 0; index <= MAX_WORKSPACE_PREVIEW_SERVERS; index += 1) {
      const root = await fixtureRoot()
      await writeFile(join(root, 'game.html'), `game-${index}`, 'utf8')
      started.push((await service().start(root, join(root, 'game.html'))).url)
    }
    expect(service().list()).toHaveLength(MAX_WORKSPACE_PREVIEW_SERVERS)
    expect((await fetch(started[0] as string).catch(() => ({ status: 0 }))).status).toBe(0)
    expect((await fetch(started.at(-1) as string)).status).toBe(200)

    const root = await fixtureRoot()
    await writeFile(join(root, 'game.html'), 'game', 'utf8')
    const last = await service().start(root, join(root, 'game.html'))
    await expect(service().stop(root)).resolves.toEqual({ stopped: true })
    await expect(service().stop(root)).resolves.toEqual({ stopped: false })
    expect((await fetch(last.url).catch(() => ({ status: 0 }))).status).toBe(0)
  })
})

describe('preview request paths', () => {
  it('keeps only token-prefixed, in-root paths', () => {
    const token = 'a'.repeat(32)
    expect(parseRequestPath(`/${token}/`, token)).toBe('')
    expect(parseRequestPath(`/${token}/game/index.html`, token)).toBe('game/index.html')
    expect(parseRequestPath(`/${token}/game/index.html?v=2`, token)).toBe('game/index.html')
    expect(parseRequestPath(`/${token}/%E4%B8%AD%E6%96%87/x.css`, token)).toBe('中文/x.css')
    expect(parseRequestPath(`/${'b'.repeat(32)}/game.html`, token)).toBeNull()
    expect(parseRequestPath(`/${token}/../outside.txt`, token)).toBeNull()
    expect(parseRequestPath(`/${token}/%2e%2e/outside.txt`, token)).toBeNull()
    expect(parseRequestPath(`/${token}/game%00.html`, token)).toBeNull()
  })
})
