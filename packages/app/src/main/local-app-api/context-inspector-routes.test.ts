import { createServer } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { AgentRunner } from '@littlesheep/runner'
import type { SessionRouteContext } from './session-routes'
import { routeContextInspector } from './context-inspector-routes'

describe('Context Inspector API privacy boundary', () => {
  it('authorizes the session before inspection and never replays logs or reads transcript', async () => {
    const inspectContext = vi.fn((sessionId: string) => ({ version: 1, sessionId, coverage: 'loaded_history', requests: [], retainedRequests: 0, truncated: false, active: false }))
    const runner = { inspectContext, replay: vi.fn(() => { throw new Error('raw log read'); }),
      sessionManager: { read: vi.fn(() => { throw new Error('transcript read'); }) } } as unknown as AgentRunner
    const context = { getRunner: () => runner, sessionIndex: { list: vi.fn(async () => [{ id: 'owned', title: 'Owned conversation', createdAt: 1, lastMessageAt: 2, workspacePath: 'PRIVATE_PATH', projectId: 'PRIVATE_PROJECT' }]) } } as unknown as SessionRouteContext
    const server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost')
      void routeContextInspector({ req, res, url, path: url.pathname, method: req.method! }, context).catch(() => { res.writeHead(500); res.end() })
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    try {
      expect((await fetch(`http://127.0.0.1:${port}/sessions/unknown/context`)).status).toBe(404)
      expect(inspectContext).not.toHaveBeenCalled()
      const response = await fetch(`http://127.0.0.1:${port}/sessions/owned/context`)
      expect(response.status).toBe(200)
      const payload = await response.json()
      expect(payload).toMatchObject({ sessionId: 'owned', requests: [], session: { title: 'Owned conversation', createdAt: 1, lastMessageAt: 2 } })
      expect(JSON.stringify(payload)).not.toContain('PRIVATE_')
      expect(runner.replay).not.toHaveBeenCalled()
      expect(runner.sessionManager.read).not.toHaveBeenCalled()
    } finally { server.close(); await once(server, 'close') }
  })
})
