import { createServer } from 'node:http'

const REQUEST_BODY_LIMIT_BYTES = 4 * 1024 * 1024
const MAX_RECORDED_REQUESTS = 4_096
const MAX_PENDING_FAULTS = 8

/**
 * Start a loopback-only forwarding proxy that adds deterministic latency
 * without replacing the real Provider. Request/response bodies are not
 * retained; only bounded timing, model and usage metadata are recorded.
 */
export async function startDelayedHttpProxy(options) {
  const upstreamBaseURL = new URL(options.upstreamBaseURL)
  const delayMs = boundedDelay(options.delayMs)
  const requests = []
  const pendingFaults = []
  let requestRecordsTruncated = false
  let nextRequestId = 1

  const server = createServer(async (req, res) => {
    const startedAt = new Date().toISOString()
    const record = {
      id: nextRequestId++,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      startedAt,
      delayMs,
      forwarded: false,
      aborted: false,
    }
    if (requests.length < MAX_RECORDED_REQUESTS) requests.push(record)
    else requestRecordsTruncated = true

    const controller = new AbortController()
    const abort = () => {
      record.aborted = true
      controller.abort()
    }
    const abortOnResponseClose = () => {
      if (!res.writableEnded && !record.injectedFault) abort()
    }
    req.once('aborted', abort)
    res.once('close', abortOnResponseClose)

    try {
      const body = await readBoundedBody(req, REQUEST_BODY_LIMIT_BYTES)
      const requestMetadata = parseRequestMetadata(body)
      if (requestMetadata.model) record.model = requestMetadata.model
      if (requestMetadata.stream !== undefined) record.stream = requestMetadata.stream
      const fault = pendingFaults.shift()
      if (fault === 'disconnect') {
        record.injectedFault = fault
        record.completedAt = new Date().toISOString()
        res.destroy()
        return
      }
      await abortableDelay(delayMs, controller.signal)

      const upstreamResponse = await fetch(resolveUpstreamURL(upstreamBaseURL, req.url), {
        method: req.method,
        headers: forwardRequestHeaders(req.headers),
        body: body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
        signal: controller.signal,
      })
      record.forwarded = true
      record.forwardedAt = new Date().toISOString()
      record.status = upstreamResponse.status

      const responseBody = Buffer.from(await upstreamResponse.arrayBuffer())
      const usage = parseResponseUsage(responseBody, upstreamResponse.headers.get('content-type'))
      if (usage) record.usage = usage
      res.writeHead(upstreamResponse.status, forwardResponseHeaders(upstreamResponse.headers))
      res.end(responseBody)
      record.completedAt = new Date().toISOString()
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
      record.completedAt = new Date().toISOString()
      if (!record.aborted && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'acceptance forwarding proxy failed' }))
      } else if (!res.writableEnded) {
        res.destroy()
      }
    } finally {
      req.removeListener('aborted', abort)
      res.removeListener('close', abortOnResponseClose)
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('delayed proxy did not bind a TCP port')

  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    requests,
    disconnectNext(count = 1) {
      const boundedCount = boundedFaultCount(count)
      if (pendingFaults.length + boundedCount > MAX_PENDING_FAULTS) {
        throw new Error(`at most ${MAX_PENDING_FAULTS} faults may be pending`)
      }
      for (let index = 0; index < boundedCount; index += 1) pendingFaults.push('disconnect')
      return pendingFaults.length
    },
    pendingFaultCount() {
      return pendingFaults.length
    },
    requestRecordsTruncated() {
      return requestRecordsTruncated
    },
    async close() {
      pendingFaults.length = 0
      server.closeAllConnections?.()
      await new Promise((resolveClose) => server.close(() => resolveClose()))
    },
  }
}

async function readBoundedBody(req, limitBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.byteLength
    if (total > limitBytes) throw new Error(`forwarded request body exceeds ${limitBytes} bytes`)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function resolveUpstreamURL(base, requestPath) {
  const inbound = new URL(requestPath ?? '/', 'http://127.0.0.1')
  const target = new URL(base.href)
  target.pathname = [target.pathname.replace(/\/$/u, ''), inbound.pathname.replace(/^\//u, '')]
    .filter(Boolean)
    .join('/') || '/'
  target.search = inbound.search
  return target
}

function forwardRequestHeaders(headers) {
  const forwarded = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (!value || shouldStripHeader(name)) continue
    if (Array.isArray(value)) value.forEach((entry) => forwarded.append(name, entry))
    else forwarded.set(name, value)
  }
  return forwarded
}

function forwardResponseHeaders(headers) {
  const forwarded = {}
  for (const [name, value] of headers.entries()) {
    if (shouldStripHeader(name) || name.toLowerCase() === 'content-encoding') continue
    forwarded[name] = value
  }
  return forwarded
}

function shouldStripHeader(name) {
  return ['connection', 'content-length', 'host', 'transfer-encoding'].includes(name.toLowerCase())
}

function parseRequestMetadata(body) {
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    return {
      model: typeof parsed.model === 'string' ? parsed.model.slice(0, 256) : undefined,
      stream: typeof parsed.stream === 'boolean' ? parsed.stream : undefined,
    }
  } catch {
    return {}
  }
}

function parseResponseUsage(body, contentType) {
  const normalizedType = contentType?.toLowerCase() ?? ''
  if (normalizedType.includes('text/event-stream')) {
    let latest
    for (const line of body.toString('utf8').split(/\r?\n/u)) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        latest = normalizedUsage(JSON.parse(payload)?.usage) ?? latest
      } catch {
        // Ignore comments, keepalive payloads and partial non-JSON lines.
      }
    }
    return latest
  }
  if (!normalizedType.includes('application/json')) return undefined
  try {
    return normalizedUsage(JSON.parse(body.toString('utf8'))?.usage)
  } catch {
    return undefined
  }
}

function normalizedUsage(usage) {
  const promptTokens = finiteInteger(usage?.prompt_tokens)
  const completionTokens = finiteInteger(usage?.completion_tokens)
  const totalTokens = finiteInteger(usage?.total_tokens)
  if (promptTokens === undefined || completionTokens === undefined) return undefined
  return {
    promptTokens,
    completionTokens,
    totalTokens: totalTokens ?? promptTokens + completionTokens,
  }
}

function finiteInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function boundedDelay(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(30_000, Math.floor(value))) : 0
}

function boundedFaultCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PENDING_FAULTS) {
    throw new Error(`fault count must be an integer between 1 and ${MAX_PENDING_FAULTS}`)
  }
  return value
}

function abortableDelay(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(signal.reason ?? new Error('aborted'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
