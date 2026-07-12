// test/e2e-webhook.test.ts
// 端到端测试：createGatewayService → 配置 webhook 渠道 → 启动 → HTTP 验证
// 复用 vitest.config.ts 的 @littlesheep/* 别名，无需 pnpm build。
//
// 与 packages/channels/webhook/src/plugin.test.ts（直接测插件）互补：
// 本测试覆盖完整链路 — config → GatewayService → ChannelManager → 插件启动 → HTTP 接收。
// 场景 5 还验证 setConfig + reload 热重载（Part 1 实现）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ConfigSchema } from '@littlesheep/config'
import { createGatewayService, type GatewayService } from '@littlesheep/gateway'
import { createWebhookPlugin, WebhookChannelPlugin } from '@littlesheep/channel-webhook'
import type { AgentRunner, RunnerResult, RunInput } from '@littlesheep/runner'
import { asSessionId, type SessionId, type Session, type SessionMetadata } from '@littlesheep/types'
import type { SessionManager } from '@littlesheep/session'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

// ── Mock Runner（in-memory session map + echo reply）──────────────

function makeMockRunner() {
  const sessions = new Map<string, Session>()
  let counter = 0

  const sessionManager = {
    async create(model?: string, _title?: string, meta?: Partial<SessionMetadata>) {
      counter++
      const id = asSessionId(`test-session-${counter}`)
      const now = new Date().toISOString()
      const session: Session = {
        id,
        metadata: { createdAt: now, updatedAt: now, messageCount: 0, model, ...meta },
        messages: [],
      }
      sessions.set(id, session)
      return session
    },
    async delete(sessionId: SessionId) { sessions.delete(sessionId) },
    sessionFile: () => '/tmp/mock',
    async loadMetadata() { return null },
    async append() {},
    async read() { return [] },
    async readRecent() { return [] },
    async updateMetadata() {},
    async load() { return null },
    async list() { return Array.from(sessions.keys()) },
    async listByChannel(channelId: string) {
      return Array.from(sessions.values())
        .filter(s => s.metadata.channelId === channelId)
        .map(s => s.id)
    },
    async stat() { return null },
  }

  const runner: AgentRunner = {
    async run(input: RunInput): Promise<RunnerResult> {
      return {
        runId: `run-${Date.now()}`,
        sessionId: (input.sessionId ?? asSessionId('default')) as SessionId,
        status: 'ok',
        reply: `echo: ${input.text}`,
        error: undefined,
        messages: [],
        trace: [],
        durationMs: 0,
      }
    },
    async replay() { return null },
    async shutdown() {},
    state: { sessionId: undefined, model: 'mock-model' },
    sessionManager: sessionManager as unknown as SessionManager,
    model: 'mock-model',
  }

  return { runner, sessions }
}

// ── 测试工具 ────────────────────────────────────────────────────────

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

function makeConfig(opts: { id: string; bearerToken?: string; path?: string }) {
  return ConfigSchema.parse({
    providers: [],
    channels: {
      channels: [{
        id: opts.id,
        type: 'webhook',
        enabled: true,
        dmPolicy: { type: 'open' },
        groupPolicy: { type: 'disabled' },
        options: {
          port: 0,
          path: opts.path ?? '/webhook',
          ...(opts.bearerToken ? { bearerToken: opts.bearerToken } : {}),
        },
        secrets: {},
      }],
    },
  })
}

// ── 测试用例 ────────────────────────────────────────────────────────

describe('e2e: gateway webhook channel', () => {
  let tmpDir: string
  let gs: GatewayService

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ls-webhook-e2e-'))
    const { runner } = makeMockRunner()
    gs = createGatewayService({
      runner,
      bindingsFile: join(tmpDir, 'channels', 'bindings.json'),
      config: makeConfig({ id: 'test-webhook' }),
      pluginFactories: new Map([['webhook', createWebhookPlugin]]),
      log: () => {}, // 静默日志，避免污染测试输出
    })
  })

  afterEach(async () => {
    if (gs.started) await gs.stop()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('场景 1：启动 webhook 渠道并暴露监听地址', async () => {
    await gs.start()
    expect(gs.started).toBe(true)
    const plugins = gs.list()
    const wh = plugins.find(p => p.type === 'webhook') as WebhookChannelPlugin | undefined
    expect(wh).toBeDefined()
    expect(wh!.running).toBe(true)
    expect(wh!.address).not.toBeNull()
    expect(wh!.address!.host).toBe('127.0.0.1')
    expect(wh!.address!.port).toBeGreaterThan(0)
  })

  it('场景 2：健康检查 GET /webhook 返回 200', async () => {
    await gs.start()
    const wh = gs.list().find(p => p.type === 'webhook') as WebhookChannelPlugin
    const res = await fetchJson(`http://127.0.0.1:${wh.address!.port}/webhook`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.service).toBe('webhook-channel')
  })

  it('场景 3：POST 消息接收 → 返回 echo 回复', async () => {
    await gs.start()
    const wh = gs.list().find(p => p.type === 'webhook') as WebhookChannelPlugin
    const res = await fetchJson(`http://127.0.0.1:${wh.address!.port}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', conversationId: 'c1', userId: 'u1' }),
    })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.reply).toBe('echo: hello')
    expect(typeof res.body.sessionId).toBe('string')
  })

  it('场景 4：缺少 text 或 conversationId 返回 400', async () => {
    await gs.start()
    const wh = gs.list().find(p => p.type === 'webhook') as WebhookChannelPlugin
    const base = `http://127.0.0.1:${wh.address!.port}/webhook`

    const noText = await fetchJson(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c2', userId: 'u2' }),
    })
    expect(noText.status).toBe(400)

    const noConvId = await fetchJson(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi', userId: 'u2' }),
    })
    expect(noConvId.status).toBe(400)
  })

  it('场景 5：Bearer 认证 — 无/错 token 返回 401，正确 token 返回 200', async () => {
    // 用带 bearerToken 的配置 reload（同时验证 Part 1 的 setConfig + reload 实现）
    gs.setConfig(makeConfig({ id: 'test-webhook-auth', bearerToken: 'secret-token-123' }))
    await gs.reload()

    const wh = gs.list().find(p => p.type === 'webhook') as WebhookChannelPlugin
    const base = `http://127.0.0.1:${wh.address!.port}/webhook`

    // 健康检查不需要认证
    const health = await fetchJson(base)
    expect(health.status).toBe(200)

    // 无 token → 401
    const noToken = await fetchJson(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi', conversationId: 'c3', userId: 'u3' }),
    })
    expect(noToken.status).toBe(401)

    // 错误 token → 401
    const wrongToken = await fetchJson(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ text: 'hi', conversationId: 'c3', userId: 'u3' }),
    })
    expect(wrongToken.status).toBe(401)

    // 正确 token → 200
    const withToken = await fetchJson(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token-123' },
      body: JSON.stringify({ text: 'hi', conversationId: 'c3', userId: 'u3' }),
    })
    expect(withToken.status).toBe(200)
    expect(withToken.body.reply).toBe('echo: hi')
  })
})
