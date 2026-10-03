import { describe, expect, it } from 'vitest'
import { filterNavigationTurns, navigationTurns } from './navigation-model'

describe('conversation directory', () => {
  const turns = navigationTurns([
    { key: 'u1', turn: 1, role: 'user', label: '修复文件边界' },
    { key: 'a1', turn: 1, role: 'assistant', label: '编辑器和预览已经调整' },
    { key: 'u2', turn: 2, role: 'user', label: 'Improve keyboard navigation' },
    { key: 'a2', turn: 2, role: 'assistant', label: 'Escape closes the panel' },
  ])
  it('uses one destination per turn while recognizing either message as current', () => {
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ key: 'u1', keys: ['u1', 'a1'], answer: '编辑器和预览已经调整' })
  })
  it('searches both question and answer and combines words without changing destinations', () => {
    expect(filterNavigationTurns(turns, '  KEYBOARD escape  ').map((turn) => turn.key)).toEqual(['u2'])
    expect(filterNavigationTurns(turns, '预览').map((turn) => turn.key)).toEqual(['u1'])
    expect(filterNavigationTurns(turns, '2').map((turn) => turn.key)).toEqual(['u2'])
    expect(filterNavigationTurns(turns, '不存在')).toEqual([])
    expect(filterNavigationTurns(turns, '')).toEqual(turns)
  })
  it('keeps a partially loaded turn navigable even if its question is outside the history window', () => {
    expect(navigationTurns([{ key: 'tail', turn: 1, role: 'assistant', label: '保留的回答' }])[0])
      .toMatchObject({ key: 'tail', question: '', answer: '保留的回答', keys: ['tail'] })
  })
})
