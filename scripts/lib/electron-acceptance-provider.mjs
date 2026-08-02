import { createServer } from 'node:http'

const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const MAX_LOGGED_REQUESTS = 512

export async function startElectronAcceptanceProvider(options = {}) {
  const requests = []
  const state = {
    requestDelayMs: Math.max(0, Number(options.requestDelayMs ?? 0)),
    modelDelayMs: new Map(),
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
      writeJson(res, 200, {
        ok: true,
        requestDelayMs: state.requestDelayMs,
        modelDelays: Object.fromEntries(state.modelDelayMs),
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
    const delayMs = state.modelDelayMs.get(model) ?? state.requestDelayMs
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
    const response = buildResponse(body, requestIndex, model)
    if (body.stream === true) writeStream(res, response)
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
    setDelay: async ({ model, delayMs, requestDelayMs }) => {
      const payload = {}
      if (model !== undefined) payload.model = model
      if (delayMs !== undefined) payload.delayMs = delayMs
      if (requestDelayMs !== undefined) payload.requestDelayMs = requestDelayMs
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
  if (system.includes('You are the VERIFY stage')) {
    return textChoice(JSON.stringify({
      verdict: 'pass',
      reason: 'glob 结果已返回，恢复目标 runtime-continuity-anchor-4827 已保留。',
      failedStepIds: [],
      usedMemoryAtomIds: [],
    }))
  }
  if (system.includes('You are the RECOVER stage')) {
    return textChoice(JSON.stringify({
      action: 'abort',
      reason: '验收 Provider 收到不可恢复路径。',
    }))
  }
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

function textChoice(content) {
  return { message: { role: 'assistant', content }, finishReason: 'stop' }
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

function writeStream(res, response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const choice = response.choices[0]
  const message = choice.message
  if (message.tool_calls?.length) {
    message.tool_calls.forEach((call, index) => {
      res.write(`data: ${JSON.stringify({
        id: response.id,
        model: response.model,
        choices: [{ index: 0, delta: { tool_calls: [{ index, ...call }] }, finish_reason: null }],
      })}\n\n`)
    })
  } else if (message.content) {
    res.write(`data: ${JSON.stringify({
      id: response.id,
      model: response.model,
      choices: [{ index: 0, delta: { content: message.content }, finish_reason: null }],
    })}\n\n`)
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

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}
