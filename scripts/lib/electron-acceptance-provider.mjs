import { createServer } from 'node:http'

const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const MAX_LOGGED_REQUESTS = 512

export async function startElectronAcceptanceProvider(options = {}) {
  const requests = []
  const state = {
    requestDelayMs: Math.max(0, Number(options.requestDelayMs ?? 0)),
    streamChunkDelayMs: boundedDelay(options.streamChunkDelayMs ?? 0),
    streamChunkCharacters: Math.max(0, Math.min(10_000, Math.round(Number(options.streamChunkCharacters) || 0))),
    modelDelayMs: new Map(),
    promptDelay: null,
    /** Faults consumed by successive Provider requests; see `normalizeFaults`. */
    faults: normalizeFaults(options.faults),
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/health') {
      writeJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && url.pathname === '/control') {
      const body = await readJson(req)
      if (typeof body.requestDelayMs === 'number') {
        state.requestDelayMs = boundedDelay(body.requestDelayMs)
      }
      if (typeof body.model === 'string' && typeof body.delayMs === 'number') {
        state.modelDelayMs.set(body.model, boundedDelay(body.delayMs))
      }
      if (typeof body.promptContains === 'string' && body.promptContains.trim() && typeof body.delayMs === 'number') {
        state.promptDelay = boundedDelay(body.delayMs) > 0
          ? { contains: body.promptContains.trim(), delayMs: boundedDelay(body.delayMs) }
          : null
      }
      if (typeof body.streamChunkDelayMs === 'number') state.streamChunkDelayMs = boundedDelay(body.streamChunkDelayMs)
      if (typeof body.streamChunkCharacters === 'number') {
        state.streamChunkCharacters = Math.max(0, Math.min(10_000, Math.round(body.streamChunkCharacters)))
      }
      if (body.clearFaults === true) state.faults = []
      if (Array.isArray(body.faults)) state.faults = normalizeFaults(body.faults)
      writeJson(res, 200, {
        ok: true,
        requestDelayMs: state.requestDelayMs,
        modelDelays: Object.fromEntries(state.modelDelayMs),
        promptDelay: state.promptDelay,
        streamChunkDelayMs: state.streamChunkDelayMs,
        streamChunkCharacters: state.streamChunkCharacters,
        faults: state.faults,
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/requests') {
      writeJson(res, 200, { requests })
      return
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      writeJson(res, 404, { error: 'not found' })
      return
    }

    const body = await readJson(req)
    const requestIndex = requests.length + 1
    const model = typeof body.model === 'string' ? body.model : 'acceptance/slow-a'
    const promptText = Array.isArray(body.messages) ? body.messages.map(messageText).join('\n') : ''
    const promptDelayMs = state.promptDelay && promptText.includes(state.promptDelay.contains)
      ? state.promptDelay.delayMs
      : undefined
    const delayMs = state.modelDelayMs.get(model) ?? promptDelayMs ?? state.requestDelayMs
    requests.push({
      requestIndex,
      receivedAt: new Date().toISOString(),
      model,
      stream: body.stream === true,
      messages: boundedMessages(body.messages),
      tools: boundedTools(body.tools),
    })
    if (requests.length > MAX_LOGGED_REQUESTS) requests.splice(0, requests.length - MAX_LOGGED_REQUESTS)
    await delay(delayMs)
    // Faults are consumed per Provider request and logged on that request, so a fixture can
    // map every transport attempt to what the Provider actually did with it.
    const fault = takeFault(state)
    if (fault) requests[requests.length - 1].fault = fault
    if (fault?.kind === 'status') {
      const headers = { 'Content-Type': 'application/json; charset=utf-8' }
      if (fault.retryAfterSeconds !== undefined) headers['Retry-After'] = String(fault.retryAfterSeconds)
      res.writeHead(fault.status, headers)
      res.end(JSON.stringify({
        error: { message: `acceptance fault: injected HTTP ${fault.status}`, type: 'acceptance_fault' },
      }))
      return
    }
    if (fault?.kind === 'hang') await delay(fault.ms)
    const response = buildResponse(body, requestIndex, model)
    if (fault?.kind === 'stream_break' && body.stream === true) {
      await writeBrokenStream(res, response, state, fault.afterChunks)
      return
    }
    if (body.stream === true) await writeStream(res, response, state)
    else writeJson(res, 200, response)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('acceptance provider did not bind a TCP port')
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    controlURL: `http://127.0.0.1:${address.port}/control`,
    requestsURL: `http://127.0.0.1:${address.port}/requests`,
    requests,
    /** Current fault queue, so a fixture can assert what is still pending. */
    faults: state.faults,
    setFaults: async (faults) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(faults === null ? { clearFaults: true } : { faults }),
      })
      if (!response.ok) throw new Error(`acceptance provider control failed: ${response.status}`)
      return response.json()
    },
    setDelay: async ({ model, delayMs, requestDelayMs, promptContains }) => {
      const payload = {}
      if (model !== undefined) payload.model = model
      if (delayMs !== undefined) payload.delayMs = delayMs
      if (requestDelayMs !== undefined) payload.requestDelayMs = requestDelayMs
      if (promptContains !== undefined) payload.promptContains = promptContains
      const response = await fetch(`http://127.0.0.1:${address.port}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) throw new Error(`acceptance provider control failed: ${response.status}`)
      return response.json()
    },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

function buildResponse(body, requestIndex, model) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const system = messages.filter((message) => message?.role === 'system').map(messageText).join('\n')
  const latestUser = [...messages].reverse().find((message) => message?.role === 'user')
  const user = messageText(latestUser)
  const response = classifyResponse({ body, system, user, messages, model, requestIndex })
  return {
    id: `acceptance-${requestIndex}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: response.message,
      finish_reason: response.finishReason,
    }],
    usage: {
      prompt_tokens: 64,
      completion_tokens: 16,
      total_tokens: 80,
    },
  }
}

function classifyResponse({ body, system, user, messages, model, requestIndex }) {
  // Deterministic long Markdown answer for the streamed-rendering fixture. Checked before
  // every other branch so the fixture always streams text and never turns into a tool call.
  if (user.includes(LONG_MARKDOWN_MARKER)) {
    return textChoice(longMarkdownAnswer())
  }
  if (system.includes('Choose the next LittleSheep activity')) {
    const activity = /使用\s*glob\s*工具|use\s+the\s+glob\s+tool/iu.test(user) ? 'execute' : 'respond'
    return textChoice(JSON.stringify({ activity, confidence: 0.99, reason: 'deterministic acceptance route' }))
  }
  if (system.includes('You are the DECIDE stage')) {
    return textChoice(JSON.stringify({
      assessment: {
        userNeed: user,
        complexity: 'trivial',
        goal: '使用 glob 检查恢复连续性标记 runtime-continuity-anchor-4827',
        successCriteria: ['glob 工具成功返回结果', '最终回答承接 runtime-continuity-anchor-4827'],
        missingInfo: [],
        needsClarification: false,
        requiresTaskBook: true,
        maxExtraScopeRatio: 1,
        rationale: '单工具验收任务',
      },
      taskBook: {
        goal: '使用 glob 检查恢复连续性标记 runtime-continuity-anchor-4827',
        complexity: 'trivial',
        successCriteria: ['glob 工具成功返回结果', '最终回答承接 runtime-continuity-anchor-4827'],
        overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: '只完成验收任务' },
        steps: [{
          id: 'step-1',
          title: '检查连续性标记',
          description: '使用 glob 工具列出工作区，并保留 runtime-continuity-anchor-4827 作为恢复目标。',
          tools: ['glob'],
          requiresApproval: false,
          execution: { mode: 'serial', dependsOn: [], resources: [], sideEffect: 'read' },
          acceptanceCriteria: ['glob 成功返回至少一个结果'],
          expectedOutput: '工作区文件清单和 runtime-continuity-anchor-4827',
        }],
      },
    }))
  }
  // No VERIFY or RECOVER branch: the kernel no longer issues those model calls
  // (VERIFY is Runtime-provable evidence, RECOVER is a Runtime-owned route).
  if (system.includes('You maintain a versioned session summary')) {
    return textChoice('当前目标是恢复并继续 runtime-continuity-anchor-4827；已完成步骤和权限结果必须保留。')
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const toolMessage = [...messages].reverse().find((message) => message?.role === 'tool')
    if (!toolMessage) {
      return toolChoice('acceptance-glob-call', 'glob', { pattern: '**/*' })
    }
    return textChoice(`已完成 ${model} 的 glob 检查，并继续承接恢复目标 runtime-continuity-anchor-4827。验收回合 ${requestIndex}。`)
  }
  if (/请只回复你会记住/iu.test(user)) {
    return textChoice(`已记录本轮目标 runtime-continuity-anchor-4827，下一轮只说“继续”时我会承接这个目标。验收回合 ${requestIndex}。`)
  }
  if (/继续|恢复|runtime-continuity-anchor-4827/iu.test([system, user].join('\n'))) {
    return textChoice(`我记得上一轮的目标是 runtime-continuity-anchor-4827；现在继续该目标，并保留已完成步骤，不会从头重做。验收回合 ${requestIndex}。`)
  }
  return textChoice(`已记录本轮目标 runtime-continuity-anchor-4827，下一轮只说“继续”时我会承接这个目标。验收回合 ${requestIndex}。`)
}

/**
 * The text a correct Markdown renderer must leave in the DOM for {@link longMarkdownAnswer}.
 *
 * The source string and the rendered DOM cannot be compared directly: headings, list and
 * quote markers, emphasis, inline-code backticks and code-fence delimiters are syntax, not
 * text. This projection is deliberately small and fixture-shaped — it is an expectation for
 * one fixed document, not a Markdown parser.
 */
export function projectMarkdownToText(markdown) {
  return markdown
    .replace(/^```[^\n]*$/gmu, '')
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/^>\s?/gmu, '')
    .replace(/^[-*]\s+/gmu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/\*\*([^*\n]+)\*\*/gu, '$1')
    .replace(/`([^`\n]+)`/gu, '$1')
}

function textChoice(content) {
  return { message: { role: 'assistant', content }, finishReason: 'stop' }
}

/**
 * Marker a script puts in its prompt to receive {@link longMarkdownAnswer} instead of the
 * short continuity reply. Exported so a fixture and this provider cannot drift apart.
 */
export const LONG_MARKDOWN_MARKER = 'MARKDOWN-LONG-FIXTURE'

/** Sentinels the fixture asserts on: the answer is only complete if both survive the stream. */
export const LONG_MARKDOWN_START = 'FIXTURE-START-4c1d'
export const LONG_MARKDOWN_END = 'FIXTURE-END-7f3a'

/**
 * One deterministic Markdown document covering every block the chat renderer treats
 * differently: heading, list, link, quote, inline code, a fenced code block (whose renderer
 * swaps from the plain fallback to the lazy highlighter), Chinese punctuation and long
 * paragraphs. It is long enough that the settled transcript scrolls in a normal window, which
 * is what lets the fixture measure a reading position. The fixture compares it against the DOM
 * and the persisted settlement text, so any edit here is an edit to the expected result.
 */
export function longMarkdownAnswer() {
  const paragraphs = [
    '这一段是较长的中文正文，用来确认流式尾部反复解析之后仍然完整；这里刻意放上省略号……以及括号（含中文括号）、全角逗号，以及数字 1,234.56 和英文 mixed content，避免只验证单一语言。',
    '第二段把答案推向需要滚动的位置，并继续检查行内代码 `resolveAnchoredScrollTop`、路径 `packages/app/src/renderer/chat/use-chat-scroll-controller.ts` 与反引号内外的空格是否原样保留。',
    '第三段用于确认新内容到达时不会把仍在阅读的读者拉到底部：段落之间保持空行，列表前后不与正文合并，引用块保持自己的行首符号。',
    '第四段继续延长正文，让流式增量跨越多个显示帧，从而在真实窗口里同时存在"正在输出"与"已经结算"两种可比较的渲染状态；这段文字不承担语义，只承担高度。',
  ]
  return [
    `## 流式渲染验收 ${LONG_MARKDOWN_START}`,
    '',
    '缓存命中率已达标：`99.13%`，详见 [验收规程](https://example.test/acceptance)。',
    '',
    ...paragraphs.flatMap((paragraph, index) => [
      `### 第 ${index + 1} 节`,
      '',
      paragraph,
      '',
      `- 第 ${index + 1} 节第一项：中文标点（，。；：「」）必须逐字保留`,
      `- 第 ${index + 1} 节第二项：行内代码 \`createLlmClient\` 与**加粗**混排`,
      `- 第 ${index + 1} 节第三项：列表后的段落不能与列表合并`,
      '',
    ]),
    '> 引用段落用于检查行首符号与左侧竖线。',
    '',
    '```ts',
    "// 高亮组件到达前后，这一行的颜色必须一致",
    "const fixture: RetryProgress = { retry: 3, maxRetries: 5, delayMs: 2_000, failureClass: 'rate_limited' }",
    "console.log('流式代码块', fixture.maxRetries)",
    '```',
    '',
    `#### 结算标记 ${LONG_MARKDOWN_END}`,
  ].join('\n')
}

function toolChoice(id, name, input) {
  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(input) },
      }],
    },
    finishReason: 'tool_calls',
  }
}

async function writeStream(res, response, state) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const choice = response.choices[0]
  const message = choice.message
  if (message.tool_calls?.length) {
    for (const [index, call] of message.tool_calls.entries()) {
      const nameChunks = splitStreamText(call.function.name, state.streamChunkCharacters)
      const argumentChunks = splitStreamText(call.function.arguments, state.streamChunkCharacters)
      const count = Math.max(nameChunks.length, argumentChunks.length)
      for (let part = 0; part < count; part += 1) {
        res.write(`data: ${JSON.stringify({
          id: response.id,
          model: response.model,
          choices: [{ index: 0, delta: { tool_calls: [{
            index,
            ...(part === 0 ? { id: call.id, type: call.type } : {}),
            function: { name: nameChunks[part] ?? '', arguments: argumentChunks[part] ?? '' },
          }] }, finish_reason: null }],
        })}\n\n`)
        await delay(state.streamChunkDelayMs)
      }
    }
  } else if (message.content) {
    for (const content of splitStreamText(message.content, state.streamChunkCharacters)) {
      res.write(`data: ${JSON.stringify({
        id: response.id,
        model: response.model,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`)
      await delay(state.streamChunkDelayMs)
    }
  }
  res.write(`data: ${JSON.stringify({
    id: response.id,
    model: response.model,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
    usage: response.usage,
  })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function splitStreamText(value, characters) {
  if (!characters || value.length <= characters) return [value]
  const chunks = []
  for (let index = 0; index < value.length; index += characters) chunks.push(value.slice(index, index + characters))
  return chunks
}

async function readJson(req) {
  let data = ''
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_REQUEST_BYTES) throw new Error('acceptance Provider request exceeded limit')
    data += chunk.toString('utf8')
  }
  return data ? JSON.parse(data) : {}
}

function writeJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function messageText(message) {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n')
}

function boundedMessages(value) {
  if (!Array.isArray(value)) return []
  return value.slice(-24).map((message) => ({
    role: message?.role,
    content: messageText(message).slice(0, 2_000),
    toolCalls: Array.isArray(message?.tool_calls)
      ? message.tool_calls.slice(0, 8).map((call) => call?.function?.name)
      : [],
  }))
}

function boundedTools(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 64).map((tool) => tool?.function?.name).filter(Boolean)
}

function boundedDelay(value) {
  return Math.max(0, Math.min(120_000, Math.round(Number(value) || 0)))
}

/**
 * Faults a fixture can inject into successive Provider requests.
 *
 *   { kind: 'status', status: 429, times: 2, retryAfterSeconds: 1 }  HTTP failure (+ hint)
 *   { kind: 'stream_break', afterChunks: 3, times: 1 }               SSE cut mid-answer
 *   { kind: 'hang', ms: 5_000, times: 1 }                            no response (client timeout)
 *
 * Every entry is bounded and a malformed one is dropped rather than accepted, so a fixture
 * cannot accidentally ask this provider to hold a connection open forever.
 */
function normalizeFaults(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 16).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const times = Math.max(1, Math.min(40, Math.round(Number(entry.times) || 1)))
    if (entry.kind === 'status') {
      const status = Math.round(Number(entry.status))
      if (!Number.isFinite(status) || status < 400 || status > 599) return []
      const retryAfterSeconds = Number.isFinite(Number(entry.retryAfterSeconds))
        ? Math.max(0, Math.min(30, Math.round(Number(entry.retryAfterSeconds))))
        : undefined
      return [{ kind: 'status', status, times, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) }]
    }
    if (entry.kind === 'stream_break') {
      return [{ kind: 'stream_break', afterChunks: Math.max(1, Math.min(200, Math.round(Number(entry.afterChunks) || 3))), times }]
    }
    if (entry.kind === 'hang') {
      return [{ kind: 'hang', ms: Math.max(1, Math.min(120_000, Math.round(Number(entry.ms) || 1_000))), times }]
    }
    return []
  })
}

/** Consume one fault from the queue, keeping the remaining repeats in place. */
function takeFault(state) {
  const fault = state.faults[0]
  if (!fault) return null
  const remaining = fault.times - 1
  if (remaining <= 0) state.faults.shift()
  else state.faults[0] = { ...fault, times: remaining }
  return { ...fault, times: 1, remaining }
}

/**
 * Start a real SSE answer, emit a few chunks, then drop the connection without `[DONE]`.
 * This is the transport shape the harness has to survive without duplicating or losing text.
 */
async function writeBrokenStream(res, response, state, afterChunks) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const message = response.choices[0].message
  const chunks = splitStreamText(message.content ?? '', state.streamChunkCharacters)
  for (const content of chunks.slice(0, afterChunks)) {
    res.write(`data: ${JSON.stringify({
      id: response.id,
      model: response.model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`)
    await delay(state.streamChunkDelayMs)
  }
  res.destroy()
}

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}
