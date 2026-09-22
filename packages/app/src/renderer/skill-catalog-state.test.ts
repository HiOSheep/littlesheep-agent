import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  initialSkillCatalogState,
  skillCatalogReducer,
  skillErrorMessage,
  type SkillCatalogAction,
  type SkillCatalogState,
} from './skill-catalog-state'

function run(...actions: SkillCatalogAction[]): SkillCatalogState {
  return actions.reduce(skillCatalogReducer, initialSkillCatalogState())
}

const alpha = { name: 'alpha', description: '第一个技能' }
const beta = { name: 'beta', description: '第二个技能' }

describe('skill catalog state', () => {
  it('stays in loading until the first list request answers', () => {
    const state = run({ type: 'load-start', requestId: 1 })

    expect(state.status).toBe('loading')
    expect(state.skills).toEqual([])
    expect(state.loadError).toBeNull()
  })

  it('treats only a successful empty response as an empty catalog', () => {
    const loaded = run({ type: 'load-start', requestId: 1 }, { type: 'load-success', requestId: 1, skills: [] })

    expect(loaded.status).toBe('ready')
    expect(loaded.skills).toEqual([])
    expect(loaded.loadError).toBeNull()
  })

  it('reports a first-load failure instead of an empty catalog', () => {
    const state = run(
      { type: 'load-start', requestId: 1 },
      { type: 'load-failure', requestId: 1, message: 'Local app API error: 500' },
    )

    expect(state.status).toBe('error')
    expect(state.loadError).toBe('Local app API error: 500')
    expect(state.stale).toBe(false)
  })

  it('keeps the loaded list and marks it stale when reloading fails', () => {
    const state = run(
      { type: 'load-start', requestId: 1 },
      { type: 'load-success', requestId: 1, skills: [alpha, beta] },
      { type: 'load-start', requestId: 2 },
      { type: 'load-failure', requestId: 2, message: 'Local app API error: 503' },
    )

    expect(state.status).toBe('ready')
    expect(state.skills).toEqual([alpha, beta])
    expect(state.stale).toBe(true)
    expect(state.loadError).toBe('Local app API error: 503')
  })

  it('keeps list and selection when only the detail read fails', () => {
    const state = run(
      { type: 'load-start', requestId: 1 },
      { type: 'load-success', requestId: 1, skills: [alpha] },
      { type: 'detail-start', requestId: 1, name: 'alpha' },
      { type: 'detail-failure', requestId: 1, name: 'alpha', message: 'Local app API error: 404' },
    )

    expect(state.skills).toEqual([alpha])
    expect(state.selected).toBeNull()
    expect(state.status).toBe('ready')
    expect(state.detailError).toBe('Local app API error: 404')
    expect(state.failedDetailName).toBe('alpha')
  })

  it('publishes only the newest detail read when skills are switched quickly', () => {
    const state = run(
      { type: 'load-start', requestId: 1 },
      { type: 'load-success', requestId: 1, skills: [alpha, beta] },
      { type: 'detail-start', requestId: 1, name: 'alpha' },
      { type: 'detail-start', requestId: 2, name: 'beta' },
      { type: 'detail-success', requestId: 1, detail: { ...alpha, body: 'A' } },
      { type: 'detail-success', requestId: 2, detail: { ...beta, body: 'B' } },
    )

    expect(state.selected).toEqual({ ...beta, body: 'B' })
  })

  it('ignores an older detail failure after a newer read started', () => {
    const state = run(
      { type: 'detail-start', requestId: 1, name: 'alpha' },
      { type: 'detail-start', requestId: 2, name: 'beta' },
      { type: 'detail-failure', requestId: 1, name: 'alpha', message: 'stale failure' },
    )

    expect(state.detailError).toBeNull()
    expect(state.failedDetailName).toBeNull()
  })

  it('still accepts the list answer that arrives while a detail is open', () => {
    const state = run(
      { type: 'load-start', requestId: 1 },
      { type: 'detail-start', requestId: 1, name: 'alpha' },
      { type: 'load-success', requestId: 1, skills: [alpha] },
    )

    expect(state.skills).toEqual([alpha])
    expect(state.status).toBe('ready')
  })

  it('ignores a superseded list answer', () => {
    const state = run(
      { type: 'load-start', requestId: 1 },
      { type: 'load-start', requestId: 2 },
      { type: 'load-success', requestId: 1, skills: [alpha] },
    )

    expect(state.skills).toEqual([])
    expect(state.status).toBe('loading')
  })

  it('clears the detail error when returning to the list', () => {
    const state = run(
      { type: 'detail-start', requestId: 1, name: 'alpha' },
      { type: 'detail-failure', requestId: 1, name: 'alpha', message: 'nope' },
      { type: 'detail-close' },
    )

    expect(state.detailError).toBeNull()
    expect(state.failedDetailName).toBeNull()
  })

  it('bounds and normalizes failure text', () => {
    expect(skillErrorMessage(new Error('  spaced   out  '))).toBe('spaced out')
    expect(skillErrorMessage(new Error(''))).toBe('原因未知')
    expect(skillErrorMessage('plain')).toBe('plain')
    expect(skillErrorMessage(new Error('x'.repeat(400)))).toHaveLength(180)
  })
})

describe('skills page status wiring', () => {
  it('renders loading, error and empty as separate outcomes with retry entries', async () => {
    const source = await readFile(new URL('./MemorySkills.tsx', import.meta.url), 'utf8')

    expect(source).toContain("status === 'loading'")
    expect(source).toContain("status === 'error'")
    expect(source).toContain("status === 'ready' && skills.length === 0")
    expect(source).toContain('ms-feedback-action')
    expect(source).toContain('loadSkills()')
    expect(source).toContain("openSkill(failedDetailName)")
    expect(source).toContain('role="alert"')
    expect(source).not.toMatch(/catch\s*\{\s*\n\s*if \(mountedRef\.current && requestId === requestRef\.current\) setSkills\(\[\]\)/u)
  })
})
