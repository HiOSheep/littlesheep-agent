import { describe, expect, it } from 'vitest'
import { applyWorkspaceTabSubsetOrder, moveWorkspaceTab } from './tab-order'


describe('workspace tab ordering', () => {
  it('moves a dragged tab to the requested final index in either direction', () => {
    expect(moveWorkspaceTab(['review', 'terminal', 'artifacts'], 'terminal', 2)).toEqual([
      'review',
      'artifacts',
      'terminal',
    ])
    expect(moveWorkspaceTab(['review', 'terminal', 'artifacts'], 'artifacts', 0)).toEqual([
      'artifacts',
      'review',
      'terminal',
    ])
  })

  it('clamps drop positions and leaves unknown tabs unchanged', () => {
    expect(moveWorkspaceTab(['review', 'terminal'], 'terminal', -10)).toEqual(['terminal', 'review'])
    expect(moveWorkspaceTab(['review', 'terminal'], 'review', 99)).toEqual(['terminal', 'review'])
    expect(moveWorkspaceTab(['review', 'terminal'], 'missing', 0)).toEqual(['review', 'terminal'])
  })

  it('reorders visible tabs without removing non-rendered session entries', () => {
    expect(applyWorkspaceTabSubsetOrder(
      ['review', 'legacy-entry', 'terminal', 'artifacts'],
      ['artifacts', 'review', 'terminal'],
    )).toEqual(['artifacts', 'legacy-entry', 'review', 'terminal'])
  })
})
