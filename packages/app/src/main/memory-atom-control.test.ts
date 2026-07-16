import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRunner } from '@littlesheep/runner'
import {
  exportRuntimeMemoryAtom,
  manageRuntimeMemoryAtom,
  suggestedMemoryAtomExportName,
} from './memory-atom-control.js'

describe('memory atom control', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('keeps advanced management behind v3 and invalidates only changed branches', async () => {
    const manageAtom = vi.fn().mockResolvedValue({
      action: 'invalidate',
      atoms: [{ id: 'atom-1', branch: 'long-term', revision: 2 }],
      audit: { id: 'audit-1', action: 'invalidate', at: '2026-07-16T02:00:00.000Z', reason: 'stale', atomIds: ['atom-1'] },
    })
    const invalidateBranch = vi.fn().mockResolvedValue(undefined)
    const runner = mockRunner({ backendKind: 'v3', manageAtom, invalidateBranch })
    const request = { action: 'invalidate' as const, atomId: 'atom-1', expectedRevision: 1, reason: 'stale' }

    await expect(manageRuntimeMemoryAtom(runner, request)).resolves.toMatchObject({ status: 'changed' })
    expect(manageAtom).toHaveBeenCalledWith(request)
    expect(invalidateBranch).toHaveBeenCalledTimes(1)
    expect(invalidateBranch).toHaveBeenCalledWith('long-term')

    const v2 = mockRunner({ backendKind: 'v2', manageAtom, invalidateBranch })
    await expect(manageRuntimeMemoryAtom(v2, request)).resolves.toMatchObject({ status: 'unsupported' })
  })

  it('exports a complete D3 evidence package with source and projection records', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-atom-export-'))
    directories.push(dataDir)
    const outputPath = join(dataDir, 'nested', 'atom.memory.json')
    const inspection = {
      backendKind: 'v3',
      nodeId: 'atom-1',
      disclosureLevel: 'D3',
      atom: { id: 'atom-1', revision: 7, sourceRefs: ['conversation-source:run-1:user-message:message-1'] },
      catalog: { atomId: 'atom-1', revision: 7 },
      envelope: { atomId: 'atom-1', atomRevision: 7 },
      neighborhood: { entities: [], relations: [], truncated: false },
      history: { atomId: 'atom-1', revision: 7, sourceRunIds: [], sourceStages: [], entries: [], truncated: false },
      projectionRecords: [{
        version: 1,
        id: 'event-1',
        idempotencyKey: 'key:event-1',
        event: { id: 'event-1', kind: 'user-statement' },
        mutation: { kind: 'update', atomId: 'atom-1' },
        atomIds: ['atom-1'],
        capturedAt: '2026-07-16T02:00:00.000Z',
        contentHash: 'hash',
      }],
    }
    const inspectNode = vi.fn().mockResolvedValue(inspection)
    const listConversationSources = vi.fn().mockResolvedValue([{
      version: 1,
      id: 'conversation-source:run-1:user-message:message-1',
      kind: 'user-message',
      sessionId: 'session-1',
      runId: 'run-1',
      occurredAt: '2026-07-16T02:00:00.000Z',
      payload: { text: 'source' },
      capturedAt: '2026-07-16T02:00:00.000Z',
      contentHash: 'hash',
    }])
    const runner = mockRunner({ backendKind: 'v3', inspectNode, listConversationSources })

    const result = await exportRuntimeMemoryAtom(runner, 'atom-1', outputPath)
    expect(result).toMatchObject({
      atomId: 'atom-1', revision: 7, sourceRecordCount: 1, projectionRecordCount: 1, outputPath,
    })
    const exported = JSON.parse(await readFile(outputPath, 'utf8')) as Record<string, unknown>
    expect(exported).toMatchObject({
      version: 1,
      kind: 'littlesheep-memory-atom-evidence',
      nodeId: 'atom-1',
      atom: { id: 'atom-1', revision: 7 },
      sourceRecords: [{ id: 'conversation-source:run-1:user-message:message-1' }],
      projectionRecords: [{ id: 'event-1' }],
    })
    expect(inspectNode).toHaveBeenCalledWith('atom-1', 'D3')
  })

  it('produces a bounded filesystem-safe export name', () => {
    expect(suggestedMemoryAtomExportName('memory:atom:1', '用户偏好: A/B?')).toBe('用户偏好- A-B-.memory.json')
  })
})

function mockRunner(options: {
  backendKind: 'v2' | 'v3'
  manageAtom?: ReturnType<typeof vi.fn>
  inspectNode?: ReturnType<typeof vi.fn>
  invalidateBranch?: ReturnType<typeof vi.fn>
  listConversationSources?: ReturnType<typeof vi.fn>
}): AgentRunner {
  return {
    infra: {
      memoryService: {
        getNode: vi.fn().mockResolvedValue({ id: 'atom-1', branch: 'long-term', isBranchRoot: false }),
        listConversationSources: options.listConversationSources ?? vi.fn().mockResolvedValue([]),
      },
      memoryRepository: {
        management: {
          status: vi.fn().mockResolvedValue({
            backendKind: options.backendKind,
            storageKind: options.backendKind === 'v3' ? 'atom-catalog' : 'legacy-index',
            retrievalSupported: options.backendKind === 'v3',
          }),
          manageAtom: options.manageAtom ?? vi.fn(),
          inspectNode: options.inspectNode ?? vi.fn(),
        },
      },
      memoryTree: { invalidateBranch: options.invalidateBranch ?? vi.fn() },
    },
  } as unknown as AgentRunner
}
