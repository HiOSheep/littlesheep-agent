// POSIX integration gate for the Main-bound exact Shell invocation contract.
// Run with the built workspace under Linux (for example from the WSL worktree).
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { createExecTool } from '../packages/tools/dist/builtin/exec.js'
import { ToolExecutionService } from '../packages/tools/dist/tool-execution-service.js'
import { attachShellInvocation, authorizeShellBatch, bindShellApprovalAuthority, shellApprovalMetrics, startAuthorizedShell } from '../packages/tools/dist/shell-authorization.js'

assert.equal(process.platform, 'linux', 'this gate must execute on POSIX')
const root = await mkdtemp(join(tmpdir(), 'ls-shell-posix-'))
const originalFixtureEnv = process.env.LS_SHELL_POSIX_AUTH_FIXTURE
process.env.LS_SHELL_POSIX_AUTH_FIXTURE = 'sensitive-posix-fixture'
try {
  const controller = new AbortController()
  const approve = async () => true
  let current = 'permission-v2:workspace-write'
  const requests = []
  const toolContext = { sessionId: 'posix-session', runId: 'posix-run', cwd: root, workspaceRoot: root,
    approve, signal: controller.signal }
  bindShellApprovalAuthority(approve, { sessionId: toolContext.sessionId, runId: toolContext.runId,
    workspaceRoot: root, workspaceId: 'posix-workspace', permission: 'workspace-write', signal: controller.signal,
    current: async () => current, decide: () => 'approval', request: async (batch) => { requests.push(batch); return true } })
  const tool = createExecTool({ interactive: false })
  const service = new ToolExecutionService({ registrations: [{ tool, source: 'builtin' }], toolContext })
  const results = await service.executeBatch([
    { callId: 'posix-1', name: 'exec', input: { command: `printf '%s\n' 'one; $(never-run)'` } },
    { callId: 'posix-2', name: 'exec', input: { command: `printf '%s\n' "$LS_SHELL_POSIX_AUTH_FIXTURE"` } },
  ])
  assert.equal(requests.length, 1, 'the frozen two-command batch uses one user decision')
  assert.deepEqual([...results.values()].map((item) => item.ok), [true, true])
  assert.match(String(results.get(0)?.output), /one; \$\(never-run\)/u)
  assert.match(String(results.get(1)?.output), /sensitive-posix-fixture/u)
  assert.equal(requests[0].commands[0].shell.path, realpathSync('/bin/sh'))
  assert.deepEqual(requests[0].commands[0].shell.args, ['-c'])
  assert.equal(JSON.stringify(requests).includes('sensitive-posix-fixture'), false)
  assert.equal(requests[0].commands[0].source, 'agent')
  assert.equal(shellApprovalMetrics(approve)?.operations, 1)

  let startCalled = false
  const changed = await authorizeShellBatch([{ index: 0, tool, input: { command: 'printf safe' } }], toolContext, 30_000)
  const invocation = { ...toolContext }
  attachShellInvocation(invocation, tool, changed.grants.get(0))
  await assert.rejects(startAuthorizedShell(invocation, tool, { command: 'printf unsafe; id' }, () => {
    startCalled = true
  }), /facts changed/u)
  assert.equal(startCalled, false, 'changed command text never reaches process launch')

  const hardDenied = await authorizeShellBatch([{ index: 0, tool, input: { command: 'format C:' } }], toolContext, 30_000)
  assert.equal(hardDenied.grants.size, 0)
  assert.equal(requests.length, 2, 'hard deny bypasses the approval UI')
  process.stdout.write(JSON.stringify({ check: 'posix-shell-authorization', ok: true,
    shell: requests[0].commands[0].shell.path, commands: requests[0].commands.length,
    approvals: shellApprovalMetrics(approve)?.operations, changedCommandStarted: startCalled }) + '\n')
} finally {
  if (originalFixtureEnv === undefined) delete process.env.LS_SHELL_POSIX_AUTH_FIXTURE
  else process.env.LS_SHELL_POSIX_AUTH_FIXTURE = originalFixtureEnv
  await rm(root, { recursive: true, force: true })
}
