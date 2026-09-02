import { describe, expect, it } from 'vitest'
import { moveSidebarItem } from './list-drag'


describe('sidebar list ordering', () => {
  it('moves only the dragged entry within its supplied boundary list', () => {
    expect(moveSidebarItem(['a', 'b', 'c'], 'b', 2)).toEqual(['a', 'c', 'b'])
    expect(moveSidebarItem(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
  })

  it('clamps the drop position and leaves unknown entries alone', () => {
    expect(moveSidebarItem(['a', 'b'], 'b', -1)).toEqual(['b', 'a'])
    expect(moveSidebarItem(['a', 'b'], 'a', 99)).toEqual(['b', 'a'])
    expect(moveSidebarItem(['a', 'b'], 'missing', 0)).toEqual(['a', 'b'])
  })
})
