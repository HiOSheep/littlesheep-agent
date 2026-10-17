import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, link, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asSessionId, type PermissionPolicyV2Snapshot, type ToolContext } from '@littlesheep/types'
import { editTool } from './builtin/edit.js'
import { readTool } from './builtin/read.js'
import { writeTool } from './builtin/write.js'
import { createInMemoryFileObservationPort } from './file-observation.js'
import { createExplicitFileContentCheckTool } from './builtin/verify-file-content.js'
import { WORKSPACE_FILE_GUARD_AVAILABLE } from './workspace-file-guard.js'
import { ToolExecutionService } from './tool-execution-service.js'

describe('Permission V2 native file tools on the real filesystem', () => {
  let roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
    roots = []
  })

  async function root(name: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), `ls-${name}-`))
    roots.push(path)
    return path
  }

  function context(workspaceRoot: string, options: {
    approve?: ToolContext['approve']
    protectedRoots?: string[]
    observation?: ToolContext['observation']
    beforeFileMutation?: NonNullable<ToolContext['versioning']>['beforeFileMutation']
  } = {}): ToolContext {
    const policy: PermissionPolicyV2Snapshot = {
      version: 2,
      preset: 'workspace-write',
      approvalPolicy: 'prompt',
      dataRoot: resolve(workspaceRoot, '..', 'application-data'),
      workspaceRoot: resolve(workspaceRoot),
      protectedRoots: options.protectedRoots ?? [],
      constraints: {
        workspaceFileWrites: WORKSPACE_FILE_GUARD_AVAILABLE ? 'available' : 'unavailable',
        shellIsolation: 'unavailable',
      },
      fullAccessConfirmed: false,
    }
    return {
      sessionId: asSessionId('workspace-file-test'),
      runId: 'workspace-file-test-run',
      cwd: workspaceRoot,
      permissionMode: 'research',
      permissionPreset: 'workspace-write',
      permissionPolicyV2: policy,
      protectedWriteRoots: options.protectedRoots,
      observation: options.observation ?? createInMemoryFileObservationPort(),
      approve: options.approve,
      ...(options.beforeFileMutation
        ? { versioning: { beforeFileMutation: options.beforeFileMutation, beforeWorkspaceMutation: async () => {} } }
        : {}),
    }
  }

  it.skipIf(!WORKSPACE_FILE_GUARD_AVAILABLE)('reads, creates, edits, and overwrites real workspace files without an approval callback', async () => {
    const workspace = await root('workspace-native')
    const observation = createInMemoryFileObservationPort()
    const service = new ToolExecutionService({
      registrations: [readTool, writeTool, editTool].map((tool) => ({ tool, source: 'builtin' as const })),
      toolContext: context(workspace, { observation }),
    })
    let sequence = 0
    const invoke = async (name: string, input: unknown) => {
      const result = await service.executeBatch([{ callId: `native-file-${sequence++}`, name, input }])
      return result.get(0)
    }

    const created = (await invoke('write', { file_path: 'created.txt', content: 'first' }))!
    expect(created.ok).toBe(true)
    await expect(readFile(join(workspace, 'created.txt'), 'utf8')).resolves.toBe('first')

    const editedFile = join(workspace, 'edit.txt')
    await writeFile(editedFile, 'prefix target suffix', 'utf8')
    await expect(invoke('read', { file_path: editedFile })).resolves.toMatchObject({ ok: true })
    const edited = (await invoke('edit', { file_path: editedFile, old_string: 'target', new_string: 'updated' }))!
    expect(edited.ok).toBe(true)
    await expect(readFile(editedFile, 'utf8')).resolves.toBe('prefix updated suffix')

    const overwriteFile = join(workspace, 'overwrite.txt')
    await writeFile(overwriteFile, 'before', 'utf8')
    await expect(invoke('read', { file_path: overwriteFile })).resolves.toMatchObject({ ok: true })
    const overwritten = (await invoke('write', { file_path: overwriteFile, content: 'after' }))!
    expect(overwritten.ok).toBe(true)
    await expect(readFile(overwriteFile, 'utf8')).resolves.toBe('after')
  })

  it.skipIf(!WORKSPACE_FILE_GUARD_AVAILABLE)('authorizes the Runtime-bound Task Outcome check through the native workspace read guard', async () => {
    const workspace = await root('workspace-task-outcome-check')
    const file = join(workspace, 'result.txt')
    await writeFile(file, 'hello', 'utf8')
    const approve = vi.fn(async () => false)
    const checker = createExplicitFileContentCheckTool({
      runId: 'workspace-file-test-run',
      requirementId: 'requirement-1',
      filePath: 'result.txt',
      expectedContent: 'hello',
    })
    const service = new ToolExecutionService({
      registrations: [{ tool: checker, source: 'run-scoped' }],
      toolContext: context(workspace, { approve }),
    })

    const result = await service.executeBatch([{
      callId: 'task-outcome-check',
      name: checker.name,
      input: {},
    }])

    expect(result.get(0)).toMatchObject({ ok: true, meta: { taskOutcomeCheck: { status: 'passed' } } })
    expect(approve).not.toHaveBeenCalled()
    expect(service.snapshot().records[0]).toMatchObject({
      toolName: checker.name,
      toolSource: 'run-scoped',
      status: 'succeeded',
      approval: { required: false, decision: 'not_required' },
    })
  })

  it.skipIf(!WORKSPACE_FILE_GUARD_AVAILABLE)('allows automatic writes only through the Main tool service invocation', async () => {
    const workspace = await root('workspace-service')
    const approve = vi.fn(async (_action: string, _detail: unknown, options?: { requiresExplicitUserApproval?: boolean }) => (
      options?.requiresExplicitUserApproval === true ? false : true
    ))
    const ctx = context(workspace, { approve })
    const service = new ToolExecutionService({
      registrations: [{ tool: writeTool, source: 'builtin' }],
      toolContext: ctx,
    })

    const mediated = await service.executeBatch([{
      callId: 'native-workspace-create',
      name: 'write',
      input: { file_path: join(workspace, 'mediated.txt'), content: 'mediated' },
    }])
    expect(mediated.get(0)?.ok).toBe(true)
    await expect(readFile(join(workspace, 'mediated.txt'), 'utf8')).resolves.toBe('mediated')
    expect(approve).not.toHaveBeenCalled()

    const direct = await writeTool.execute({
      file_path: join(workspace, 'direct.txt'),
      content: 'requires approval',
    }, ctx)
    expect(direct.ok).toBe(false)
    expect(approve).toHaveBeenCalledWith('write', expect.anything(), { requiresExplicitUserApproval: true })
    await expect(readFile(join(workspace, 'direct.txt'), 'utf8')).rejects.toThrow()
  })

  it.skipIf(!WORKSPACE_FILE_GUARD_AVAILABLE)('auto-reads only through the guarded Main builtin reader', async () => {
    const workspace = await root('workspace-reader')
    const target = join(workspace, 'read-me.txt')
    await writeFile(target, 'trusted workspace content', 'utf8')
    const approve = vi.fn(async () => false)
    const ctx = context(workspace, { approve })
    const service = new ToolExecutionService({
      registrations: [{ tool: readTool, source: 'builtin' }],
      toolContext: ctx,
    })

    const mediated = await service.executeBatch([{
      callId: 'native-workspace-read',
      name: 'read',
      input: { file_path: target },
    }])
    expect(mediated.get(0)).toMatchObject({ ok: true, output: 'trusted workspace content' })
    expect(approve).not.toHaveBeenCalled()

    const direct = await readTool.execute({ file_path: target }, ctx)
    expect(direct.ok).toBe(false)
    expect(approve).toHaveBeenCalledWith('read', expect.anything(), { requiresExplicitUserApproval: true })
  })

  it.skipIf(!WORKSPACE_FILE_GUARD_AVAILABLE)('hard-denies an unsafe workspace file identity even when the approval callback would approve it', async () => {
    const parent = await root('workspace-service-unsafe')
    const workspace = join(parent, 'workspace')
    const outside = join(parent, 'outside')
    const outsideFile = join(outside, 'sentinel.txt')
    const hardLinkPath = join(workspace, 'hardlink.txt')
    await mkdir(workspace)
    await mkdir(outside)
    await writeFile(outsideFile, 'outside-original', 'utf8')
    await link(outsideFile, hardLinkPath)
    const approve = vi.fn(async () => true)
    const service = new ToolExecutionService({
      registrations: [{ tool: writeTool, source: 'builtin' }],
      toolContext: context(workspace, { approve }),
    })

    const result = await service.executeBatch([{
      callId: 'unsafe-workspace-file-identity',
      name: 'write',
      input: { file_path: hardLinkPath, content: 'must not change' },
    }])

    expect(result.get(0)?.ok).toBe(false)
    expect(approve).not.toHaveBeenCalled()
    expect(service.snapshot().records[0]).toMatchObject({
      status: 'hard_denied', approval: { required: false, decision: 'blocked' },
    })
    expect(await readFile(outsideFile, 'utf8')).toBe('outside-original')
  })

  it.skipIf(!WORKSPACE_FILE_GUARD_AVAILABLE)('refuses traversal, external paths, and protected roots without approval', async () => {
    const parent = await root('workspace-boundary')
    const workspace = join(parent, 'workspace')
    const outsideFile = join(parent, 'outside.txt')
    await mkdir(workspace)
    await writeFile(outsideFile, 'outside-original', 'utf8')
    const protectedDir = join(workspace, 'protected')
    await mkdir(protectedDir)
    const protectedFile = join(protectedDir, 'source.ts')
    await writeFile(protectedFile, 'source-original', 'utf8')
    const approve = vi.fn(async () => false)
    const ctx = context(workspace, { approve, protectedRoots: [protectedDir] })

    for (const filePath of ['..\\outside.txt', outsideFile]) {
      const result = await writeTool.execute({ file_path: filePath, content: 'changed' }, ctx)
      expect(result.ok).toBe(false)
    }
    const protectedResult = await writeTool.execute({ file_path: protectedFile, content: 'changed' }, ctx)
    expect(protectedResult.ok).toBe(false)
    expect(await readFile(outsideFile, 'utf8')).toBe('outside-original')
    expect(await readFile(protectedFile, 'utf8')).toBe('source-original')
    expect(approve).toHaveBeenCalled()
  })

  it.skipIf(!WORKSPACE_FILE_GUARD_AVAILABLE)('does not follow a real Windows directory junction or a hard link into another root', async () => {
    const workspace = await root('workspace-reparse')
    const outside = await root('workspace-reparse-outside')
    const outsideFile = join(outside, 'sentinel.txt')
    await writeFile(outsideFile, 'outside-original', 'utf8')
    const junction = join(workspace, 'junction')
    await symlink(outside, junction, 'junction')
    const hardLinkPath = join(workspace, 'hardlink.txt')
    await link(outsideFile, hardLinkPath)
    const approve = vi.fn(async () => true)
    const ctx = context(workspace, { approve })

    const junctionWrite = await writeTool.execute({ file_path: join(junction, 'sentinel.txt'), content: 'changed' }, ctx)
    const hardLinkWrite = await writeTool.execute({ file_path: hardLinkPath, content: 'changed' }, ctx)
    expect(junctionWrite.ok).toBe(false)
    expect(hardLinkWrite.ok).toBe(false)
    expect(approve).not.toHaveBeenCalled()
    expect(await readFile(outsideFile, 'utf8')).toBe('outside-original')
  })

  it.skipIf(!WORKSPACE_FILE_GUARD_AVAILABLE)('detects an actual parent-directory replacement with a junction before the write', async () => {
    const workspace = await root('workspace-race')
    const outside = await root('workspace-race-outside')
    const targetDir = join(workspace, 'replace-me')
    const retiredDir = join(workspace, 'retired')
    await mkdir(targetDir)
    const target = join(targetDir, 'sentinel.txt')
    await writeFile(target, 'workspace-original', 'utf8')
    const outsideFile = join(outside, 'sentinel.txt')
    await writeFile(outsideFile, 'outside-original', 'utf8')
    const observation = createInMemoryFileObservationPort()
    const ctx = context(workspace, {
      observation,
      beforeFileMutation: async () => {
        await rename(targetDir, retiredDir)
        await symlink(outside, targetDir, 'junction')
      },
    })
    const service = new ToolExecutionService({
      registrations: [readTool, writeTool].map((tool) => ({ tool, source: 'builtin' as const })),
      toolContext: ctx,
    })
    await service.executeBatch([{ callId: 'race-read', name: 'read', input: { file_path: target } }])

    const result = (await service.executeBatch([{
      callId: 'race-write', name: 'write', input: { file_path: target, content: 'must not escape' },
    }])).get(0)!
    expect(result.ok).toBe(false)
    expect(await readFile(outsideFile, 'utf8')).toBe('outside-original')
    await expect(readFile(target, 'utf8')).resolves.toBe('workspace-original')
    await expect(readFile(join(retiredDir, 'sentinel.txt'), 'utf8')).rejects.toThrow()
  })

  it.skipIf(!WORKSPACE_FILE_GUARD_AVAILABLE)('does not commit a native workspace write after cancellation during checkpoint preparation', async () => {
    const workspace = await root('workspace-cancelled')
    const target = join(workspace, 'cancelled.txt')
    const controller = new AbortController()
    const ctx = context(workspace, { beforeFileMutation: async () => controller.abort() })
    ctx.signal = controller.signal
    const service = new ToolExecutionService({
      registrations: [{ tool: writeTool, source: 'builtin' }],
      toolContext: ctx,
    })
    const result = (await service.executeBatch([{
      callId: 'cancelled-create', name: 'write', input: { file_path: target, content: 'must not commit' },
    }])).get(0)!
    expect(result.ok).toBe(false)
    await expect(readFile(target, 'utf8')).rejects.toThrow()
  })
})
