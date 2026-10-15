import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import { createExecTool, ToolExecutionService, shellApprovalMetrics } from '@littlesheep/tools'
import { resolveRunPolicy, type RunApprovalRequest } from './run-policy.js'
import { captureShellAuthorizationScope } from './shell-authorization-scope.js'

const roots: string[] = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })

async function host() {
  const root = await mkdtemp(join(tmpdir(), 'ls-main-shell-')); roots.push(root)
  let mode: 'workspace-write' | 'read-only' = 'workspace-write'
  const sessionIndex = { list: async () => [{ id: 's', title: 'fixture', createdAt: 0, lastMessageAt: 0,
    mode, permissionVersion: 2 as const, scope: 'standalone' as const, workspacePath: root }] }
  const scope = await captureShellAuthorizationScope({ runId: 'r', sessionId: 's', sessionIndex, projectIndex: { list: async () => [] } })
  const broker = vi.fn(async (_request: RunApprovalRequest) => true)
  const policy = resolveRunPolicy({ permissionPreset: 'workspace-write' }, DEFAULT_CONFIG, broker,
    { cwd: root, workspaceRoot: root, shellScope: scope })
  const service = new ToolExecutionService({ registrations: [{ tool: createExecTool({ interactive: false }), source: 'builtin' }],
    toolContext: { sessionId: 's' as never, runId: 'r', cwd: root, workspaceRoot: root, approve: policy.approve,
      permissionPolicyV2: policy.permissionPolicyV2 } })
  const run = (commands: string[]) => service.executeBatch(commands.map((command, index) => ({ callId: `fixture-${index}`, name: 'exec', input: { command } })))
  return { broker, policy, service, run, downgrade() { mode = 'read-only' } }
}

describe('Main + ToolExecutionService S1 integration', () => {
  it('approves one frozen concrete batch through Main and executes only those commands', async () => {
    const f = await host()
    const result = await f.run(['echo main-first', 'echo main-second'])
    expect([...result.values()].map((item) => item.ok)).toEqual([true, true])
    expect(f.broker).toHaveBeenCalledOnce()
    expect(f.broker.mock.calls[0]![0]).toMatchObject({ action: 'exec', permissionPreset: 'workspace-write',
      requiresExplicitUserApproval: true, shellBatch: { scope: 'batch', commands: [
        { command: 'echo main-first', sessionId: 's', runId: 'r' }, { command: 'echo main-second' },
      ] } })
    await f.run(['echo later'])
    expect(f.broker).toHaveBeenCalledTimes(2)
    expect(shellApprovalMetrics(f.policy.approve)).toMatchObject({ calls: 3, operations: 2, approved: 3 })
  })

  it('does not ask or spawn when any batch item hits a hard deny', async () => {
    const f = await host()
    expect([...(await f.run(['echo should-not-run', 'format C:'])).values()].every((item) => !item.ok)).toBe(true)
    expect(f.broker).not.toHaveBeenCalled()
  })

  it('rechecks live session downgrade after user approval and before process start', async () => {
    const f = await host()
    f.broker.mockImplementation(async () => { f.downgrade(); return true })
    const results = await f.run(['echo should-not-run'])
    expect(results.get(0)?.ok).toBe(false)
    expect(results.get(0)?.error).toContain('Main session permission or workspace ownership changed')
    expect(shellApprovalMetrics(f.policy.approve)?.invalidated).toBe(1)
  })

  it('does not share a batch decision between concurrent identical calls', async () => {
    const f = await host()
    const decisions: Array<(value: boolean) => void> = []
    f.broker.mockImplementation(() => new Promise((resolve) => { decisions.push(resolve) }))
    const first = f.run(['echo same command'])
    await vi.waitFor(() => expect(f.broker).toHaveBeenCalledTimes(1))
    const second = f.run(['echo same command'])
    decisions[0]!(true)
    expect((await first).get(0)?.ok).toBe(true)
    await vi.waitFor(() => expect(f.broker).toHaveBeenCalledTimes(2))
    decisions[1]!(true)
    expect((await second).get(0)?.ok).toBe(true)
    expect(shellApprovalMetrics(f.policy.approve)).toMatchObject({ calls: 2, operations: 2, approved: 2 })
  })

  it('does not reuse raw tool grants from a restored or serialized approval callback', async () => {
    const f = await host()
    const tool = createExecTool({ interactive: false })
    const result = await tool.execute({ command: 'echo bypass' }, { cwd: process.cwd(), sessionId: 's' as never,
      runId: 'r', permissionMode: 'full', approve: f.policy.approve })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Main invocation authorization unavailable')
    expect(f.broker).not.toHaveBeenCalled()
  })

  it('measures reduced approval operations for the same fixed command set', async () => {
    const single = await host()
    for (const command of ['echo one', 'echo two', 'echo three']) await single.run([command])
    const batched = await host(); await batched.run(['echo one', 'echo two', 'echo three'])
    expect(shellApprovalMetrics(single.policy.approve)).toMatchObject({ calls: 3, operations: 3 })
    expect(shellApprovalMetrics(batched.policy.approve)).toMatchObject({ calls: 3, operations: 1 })
    // This measures fixture decisions, not a claim about human reaction time.
  })
})
