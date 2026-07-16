import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRunner } from '@littlesheep/runner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localAppApiItemPath, LOCAL_APP_API_PREFIXES } from '../../shared/local-app-api-routes.js'
import { routeMemoryAtom, type MemoryAtomRouteContext } from './memory-atom-routes.js'

describe('memory atom Local App API routes', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('validates and applies an advanced atom management request', async () => {
    const manageAtom = vi.fn().mockResolvedValue({
      action: 'invalidate',
      atoms: [{ id: 'atom-1', branch: 'long-term', revision: 2 }],
      audit: { id: 'audit-1', action: 'invalidate', at: '2026-07-16T03:00:00.000Z', reason: 'stale' },
    })
    const runner = mockRunner({ manageAtom })
    const path = localAppApiItemPath(LOCAL_APP_API_PREFIXES.memoryNodes, 'atom-1', '/manage-atom')

    const invalid = await invokeRoute(path, { action: 'invalidate', expectedRevision: 1 }, { runner })
    expect(invalid).toMatchObject({ status: 400, body: { error: 'reason is required' } })
    expect(manageAtom).not.toHaveBeenCalled()

    const response = await invokeRoute(path, {
      action: 'invalidate',
      expectedRevision: 1,
      reason: 'stale',
    }, { runner })
    expect(response).toMatchObject({
      status: 200,
      body: { action: 'invalidate', atoms: [{ id: 'atom-1', revision: 2 }] },
    })
    expect(manageAtom).toHaveBeenCalledTimes(1)
  })

  it('exports the selected atom as a D3 evidence file', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-atom-route-'))
    directories.push(dataDir)
    const outputPath = join(dataDir, 'exports', 'atom.memory.json')
    const runner = mockRunner({
      inspectNode: vi.fn().mockResolvedValue({
        backendKind: 'v3',
        nodeId: 'atom-1',
        disclosureLevel: 'D3',
        atom: { id: 'atom-1', revision: 4 },
        catalog: { atomId: 'atom-1', revision: 4 },
        envelope: { atomId: 'atom-1', atomRevision: 4 },
        neighborhood: { entities: [], relations: [], truncated: false },
        history: { atomId: 'atom-1', revision: 4, entries: [], truncated: false },
        immutableFacts: [{ id: 'event-1' }],
      }),
    })
    const selectMemoryAtomExport = vi.fn().mockResolvedValue(outputPath)
    const path = localAppApiItemPath(LOCAL_APP_API_PREFIXES.memoryNodes, 'atom-1', '/export')

    const response = await invokeRoute(path, {}, { runner, selectMemoryAtomExport })
    expect(response).toMatchObject({
      status: 200,
      body: {
        cancelled: false,
        export: { outputPath, atomId: 'atom-1', revision: 4, immutableFactCount: 1 },
      },
    })
    expect(selectMemoryAtomExport).toHaveBeenCalledWith('Remember locally.memory.json')
    const exported = JSON.parse(await readFile(outputPath, 'utf8')) as Record<string, unknown>
    expect(exported).toMatchObject({ kind: 'littlesheep-memory-atom-evidence', nodeId: 'atom-1' })
  })
})

async function invokeRoute(
  path: string,
  body: Record<string, unknown>,
  context: MemoryAtomRouteContext,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    void routeMemoryAtom({
      req,
      res,
      url,
      path: url.pathname,
      method: req.method ?? 'GET',
    }, context).then((handled) => {
      if (!handled && !res.writableEnded) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not handled' }))
      }
    }).catch((error: unknown) => {
      if (res.writableEnded) return
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    })
  })
  await listen(server)
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP address')
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  } finally {
    await close(server)
  }
}

async function listen(server: Server): Promise<void> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  server.close()
  await once(server, 'close')
}

function mockRunner(options: {
  manageAtom?: ReturnType<typeof vi.fn>
  inspectNode?: ReturnType<typeof vi.fn>
}): AgentRunner {
  return {
    infra: {
      memoryService: {
        getNode: vi.fn().mockResolvedValue({
          id: 'atom-1',
          summary: 'Remember locally',
          branch: 'long-term',
          isBranchRoot: false,
        }),
      },
      memoryRepository: {
        management: {
          status: vi.fn().mockResolvedValue({ backendKind: 'v3', storageKind: 'atom-catalog' }),
          manageAtom: options.manageAtom ?? vi.fn(),
          inspectNode: options.inspectNode ?? vi.fn(),
        },
      },
      memoryTree: { invalidateBranch: vi.fn().mockResolvedValue(undefined) },
    },
  } as unknown as AgentRunner
}
