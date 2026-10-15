import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import { createExecTool, ToolExecutionService } from '@littlesheep/tools'
import type { RunApprovalRequest } from './run-policy.js'
import { ShellRepeatAuthorizationStore } from './shell-repeat-authorization-store.js'
import { resolveRunPolicy } from './run-policy.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('Main exact Shell repeat authorization execution', () => {
  it('uses the Main remembered choice only for matching host process launches in the same session', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ls-shell-repeat-execution-'))
    roots.push(workspace)
    const sessionId = 'session-repeat-test'
    const store = new ShellRepeatAuthorizationStore()
    const approvalRequests: RunApprovalRequest[] = []
    const approvals = vi.fn(async (request: RunApprovalRequest) => {
      approvalRequests.push(request)
      return request.rememberShellCommandAvailable
        ? { approved: true as const, rememberShellCommand: true as const }
        : true
    })

    const createService = (runId: string) => {
      const policy = resolveRunPolicy({ permissionPreset: 'workspace-write' }, DEFAULT_CONFIG, approvals, {
        workspaceRoot: workspace,
        cwd: workspace,
        shellScope: {
          runId,
          sessionId,
          workspaceId: 'workspace-repeat-test',
          current: async () => JSON.stringify({ sessionId, workspace, preset: 'workspace-write' }),
        },
        shellRepeatAuthorization: {
          consume: (description) => store.consume(description),
          remember: (description) => store.remember(description),
        },
      })
      const toolContext = {
        cwd: workspace,
        workspaceRoot: workspace,
        sessionId: sessionId as never,
        runId,
        approve: policy.approve,
        signal: new AbortController().signal,
      }
      return new ToolExecutionService({
        registrations: [{ tool: createExecTool({ interactive: false }), source: 'builtin' }],
        toolContext,
      })
    }

    const first = createService('run-one')
    const firstResult = await first.executeBatch([{ callId: 'first-pwd', name: 'exec', input: { command: 'pwd' } }])
    expect(firstResult.get(0)).toMatchObject({ ok: true })
    expect(String(firstResult.get(0)?.output)).toContain(workspace)
    expect(approvals).toHaveBeenCalledOnce()
    const request = approvalRequests[0]!
    expect(request).toMatchObject({ action: 'exec', permissionPreset: 'workspace-write', rememberShellCommandAvailable: true })

    const second = createService('run-two')
    const secondResult = await second.executeBatch([{ callId: 'second-pwd', name: 'exec', input: { command: 'pwd' } }])
    expect(secondResult.get(0)).toMatchObject({ ok: true })
    expect(String(secondResult.get(0)?.output)).toContain(workspace)
    expect(approvals).toHaveBeenCalledOnce()

    const changed = createService('run-three')
    const changedResult = await changed.executeBatch([{ callId: 'changed-command', name: 'exec', input: { command: 'pwd ' } }])
    expect(changedResult.get(0)).toMatchObject({ ok: true })
    expect(approvals).toHaveBeenCalledTimes(2)

    const afterContextChange = createService('run-four')
    const afterContextChangeResult = await afterContextChange.executeBatch([{ callId: 'pwd-after-change', name: 'exec', input: { command: 'pwd' } }])
    expect(afterContextChangeResult.get(0)).toMatchObject({ ok: true })
    expect(approvals).toHaveBeenCalledTimes(3)
  })
})
