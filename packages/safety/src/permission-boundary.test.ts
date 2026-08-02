import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authorizeToolAccess,
  describeToolAccess,
  shouldRequestPermissionApproval,
} from './permission-boundary.js'

const roots: string[] = []

async function makeFixture(): Promise<{ containerRoot: string; cwd: string; insideFile: string; outsideFile: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'littlesheep-permission-'))
  roots.push(parent)
  const containerRoot = join(parent, 'container')
  const outsideRoot = join(parent, 'outside')
  await mkdir(join(containerRoot, 'workplace'), { recursive: true })
  await mkdir(outsideRoot, { recursive: true })
  const insideFile = join(containerRoot, 'workplace', 'inside.txt')
  const outsideFile = join(outsideRoot, 'outside.txt')
  await writeFile(insideFile, 'inside', 'utf8')
  await writeFile(outsideFile, 'outside', 'utf8')
  return { containerRoot, cwd: containerRoot, insideFile, outsideFile }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('permission boundary', () => {
  it('classifies absolute and relative paths against the movable data root', async () => {
    const fixture = await makeFixture()
    expect(describeToolAccess('read', { file_path: fixture.insideFile }, fixture).boundary).toBe('inside')
    expect(describeToolAccess('read', { file_path: fixture.outsideFile }, fixture).boundary).toBe('outside')
    expect(describeToolAccess('read', { file_path: 'workplace/inside.txt' }, {
      cwd: fixture.containerRoot,
      containerRoot: fixture.containerRoot,
    }).boundary).toBe('inside')
  })

  it('uses the strict mode matrix', async () => {
    const fixture = await makeFixture()
    const insideRead = describeToolAccess('read', { file_path: fixture.insideFile }, fixture)
    const insideWrite = describeToolAccess('write', { file_path: fixture.insideFile }, fixture)
    const insideExec = describeToolAccess('exec', { command: 'pwd', cwd: fixture.containerRoot }, fixture)
    const outsideRead = describeToolAccess('read', { file_path: fixture.outsideFile }, fixture)

    expect(shouldRequestPermissionApproval('full', insideRead)).toBe(false)
    expect(shouldRequestPermissionApproval('full', insideWrite)).toBe(false)
    expect(shouldRequestPermissionApproval('full', insideExec)).toBe(false)
    expect(shouldRequestPermissionApproval('full', outsideRead)).toBe(false)
    expect(shouldRequestPermissionApproval('full', {
      action: 'execute',
      boundary: 'unknown',
      paths: [],
      reason: 'dynamic command',
    })).toBe(false)
    expect(shouldRequestPermissionApproval('research', insideRead)).toBe(false)
    expect(shouldRequestPermissionApproval('research', insideWrite)).toBe(true)
    expect(shouldRequestPermissionApproval('research', insideExec)).toBe(true)
    expect(shouldRequestPermissionApproval('research', outsideRead)).toBe(true)
    expect(shouldRequestPermissionApproval('restricted', insideRead)).toBe(true)
  })

  it('treats explicit external command paths and dynamic shell access conservatively', async () => {
    const fixture = await makeFixture()
    const explicit = describeToolAccess('exec', {
      command: `Get-Content "${fixture.outsideFile}"`,
      cwd: fixture.containerRoot,
    }, fixture)
    const parentTraversal = describeToolAccess('exec', {
      command: 'Get-Content ..\\..\\outside\\outside.txt',
      cwd: join(fixture.containerRoot, 'workplace'),
    }, fixture)
    const dynamic = describeToolAccess('exec', {
      command: 'Get-Content $HOME\\secret.txt',
      cwd: fixture.containerRoot,
    }, fixture)

    expect(explicit.boundary).toBe('outside')
    expect(parentTraversal.boundary).toBe('outside')
    expect(dynamic.boundary).toBe('unknown')
  })

  it('treats host-side interpreter evaluation as opaque even when cwd is inside', async () => {
    const fixture = await makeFixture()
    for (const command of ['node -e process.exit(0)', 'python -c pass']) {
      expect(describeToolAccess('exec', {
        command,
        cwd: fixture.containerRoot,
      }, fixture).boundary).toBe('unknown')
    }
    expect(describeToolAccess('exec', {
      command: 'node --version',
      cwd: fixture.containerRoot,
    }, fixture).boundary).toBe('inside')
  })

  it('uses a one-call approval and denies when the callback is absent or rejects', async () => {
    const fixture = await makeFixture()
    const approve = vi.fn(async () => true)
    const context = {
      cwd: fixture.containerRoot,
      containerRoot: fixture.containerRoot,
      permissionMode: 'research' as const,
      approve,
    }
    await expect(authorizeToolAccess('write', { file_path: fixture.insideFile }, context)).resolves.toMatchObject({
      allowed: true,
      approvedByPolicy: true,
    })
    expect(approve).toHaveBeenCalledTimes(1)
    await expect(authorizeToolAccess('read', { file_path: fixture.insideFile }, {
      ...context,
      approvalGranted: true,
    })).resolves.toMatchObject({ allowed: true, approvedByPolicy: false })
    await expect(authorizeToolAccess('write', { file_path: fixture.insideFile }, {
      ...context,
      approve: async () => false,
    })).resolves.toMatchObject({ allowed: false, reason: 'approval denied' })
  })

  it('lets confirmed full access cover unknown host boundaries', async () => {
    const approve = vi.fn(async () => false)
    await expect(authorizeToolAccess('read', { file_path: 'outside.txt' }, {
      cwd: process.cwd(),
      permissionMode: 'full',
      approve,
    })).resolves.toMatchObject({
      allowed: true,
      boundary: 'unknown',
      approvedByPolicy: true,
    })
    expect(approve).not.toHaveBeenCalled()
  })
})
