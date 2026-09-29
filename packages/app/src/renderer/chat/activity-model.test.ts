import { describe, expect, it } from 'vitest'
import { isLiveStepVisible, visibleActivitySteps } from './activity-visibility'
import { artifactIdentity, buildArtifactsFromToolCalls, upsertLiveTool } from './activity-model'
import type { LiveStepEvent } from './types'

const pendingStep: LiveStepEvent = {
  stepId: 'step-1',
  title: '尚未开始',
  status: 'pending',
  toolCount: 0,
  activeTools: 0,
}

describe('assistant activity progressive disclosure', () => {
  it('updates a completed tool in place instead of appending a second row', () => {
    const started = upsertLiveTool([], {
      callId: 'tool-1',
      name: 'read_file',
      input: { path: 'src/main.ts' },
      ok: undefined,
    })
    const completed = upsertLiveTool(started, {
      callId: 'tool-1',
      name: 'read_file',
      ok: true,
      output: 'done',
    })

    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ callId: 'tool-1', ok: true, output: 'done' })
  })

  it('keeps untouched task-book steps hidden until execution reaches them', () => {
    expect(isLiveStepVisible(pendingStep)).toBe(false)
    expect(visibleActivitySteps({ steps: [pendingStep] })).toEqual([])
  })

  it('reveals a step as soon as status, timing, or tool activity proves it started', () => {
    const startedByStatus = { ...pendingStep, status: 'running' as const }
    const startedByTime = { ...pendingStep, startedAt: 0 }
    const startedByTool = { ...pendingStep, toolCount: 1 }

    expect(isLiveStepVisible(startedByStatus)).toBe(true)
    expect(isLiveStepVisible(startedByTime)).toBe(true)
    expect(isLiveStepVisible(startedByTool)).toBe(true)
    expect(visibleActivitySteps({ steps: [pendingStep, startedByStatus] })).toEqual([startedByStatus])
  })
})

describe('artifact rows identify a file, not a spelling', () => {
  it('counts one file once when a turn writes it under two spellings', () => {
    // Measured in a real window (2026-09-29): a turn that wrote `o3-out/notes.txt` and then
    // `O3-OUT/NOTES.TXT` rendered "已产出 2 个文件" with two rows for one file on this platform.
    const artifacts = buildArtifactsFromToolCalls([
      { name: 'write', input: { file_path: 'o3-out/notes.txt' }, ok: true },
      { name: 'write', input: { file_path: 'O3-OUT/NOTES.TXT' }, ok: true },
    ])

    expect(artifacts).toHaveLength(1)
    expect(artifacts?.[0]).toMatchObject({ path: 'o3-out/notes.txt', name: 'notes.txt', action: 'created' })
    expect(artifactIdentity('O3-OUT\\NOTES.TXT')).toBe(artifactIdentity('o3-out/notes.txt'))
  })

  it('keeps the first spelling and the created action, and still separates different files', () => {
    const artifacts = buildArtifactsFromToolCalls([
      { name: 'write', input: { file_path: 'docs/report.md' }, ok: true },
      { name: 'edit', input: { file_path: 'DOCS\\REPORT.MD' }, ok: true },
      { name: 'edit', input: { file_path: 'docs/appendix.md' }, ok: true },
    ])

    expect(artifacts?.map((artifact) => `${artifact.path}:${artifact.action}`)).toEqual([
      'docs/report.md:created',
      'docs/appendix.md:modified',
    ])
  })

  it('drops a tool whose call failed', () => {
    expect(buildArtifactsFromToolCalls([
      { name: 'write', input: { file_path: 'denied.txt' }, ok: false },
    ])).toBeUndefined()
  })
})
