import { describe, expect, it } from 'vitest'
import { isWindowDragPoint } from './window-drag-contracts.js'

describe('window drag contracts', () => {
  it('accepts finite screen coordinates in the supported desktop range', () => {
    expect(isWindowDragPoint({ screenX: -1536, screenY: 1080 })).toBe(true)
    expect(isWindowDragPoint({ screenX: 0, screenY: 0 })).toBe(true)
  })

  it('rejects malformed or unsafe IPC payloads', () => {
    expect(isWindowDragPoint(null)).toBe(false)
    expect(isWindowDragPoint({ screenX: '12', screenY: 8 })).toBe(false)
    expect(isWindowDragPoint({ screenX: Number.NaN, screenY: 8 })).toBe(false)
    expect(isWindowDragPoint({ screenX: Infinity, screenY: 8 })).toBe(false)
    expect(isWindowDragPoint({ screenX: 100_001, screenY: 8 })).toBe(false)
  })
})
