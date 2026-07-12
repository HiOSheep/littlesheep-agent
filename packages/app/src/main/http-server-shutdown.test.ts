import { createServer, get } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { closeHttpServer } from './http-server-shutdown.js'

describe('closeHttpServer', () => {
  it('closes a listening server normally', async () => {
    const server = createServer((_req, res) => res.end('ok'))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')

    await closeHttpServer(server, { forceAfterMs: 100 })

    expect(server.listening).toBe(false)
  })

  it('does not wait forever for an active streaming response', async () => {
    let resolveRequestStarted: (() => void) | undefined
    const requestStarted = new Promise<void>((resolve) => {
      resolveRequestStarted = resolve
    })
    const server = createServer(() => resolveRequestStarted?.())
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP address')

    const request = get(`http://127.0.0.1:${address.port}`)
    request.on('error', () => undefined)
    await requestStarted

    await expect(closeHttpServer(server, { forceAfterMs: 20 })).resolves.toBeUndefined()
    expect(server.listening).toBe(false)
  })

  it('is safe when the server is already closed', async () => {
    const server = createServer()

    await expect(closeHttpServer(server, { forceAfterMs: 20 })).resolves.toBeUndefined()
  })
})
