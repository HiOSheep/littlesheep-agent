import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  clampTaskPillOffset,
  isTaskPillDocked,
  readTaskPillOffset,
  TASK_PILL_OFFSET_STORAGE,
  writeTaskPillOffset,
} from './task-pill-drag'

const column = { left: 100, top: 40, right: 900, bottom: 800 }
const docked = { left: 102, top: 48, right: 402, bottom: 80 }

function memoryStorage(initial?: string) {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set(TASK_PILL_OFFSET_STORAGE, initial)
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

describe('task pill drag', () => {
  it('keeps the pill inside the chat column', () => {
    // A pill 300x32 docked at 102,48 in a column 100,40..900,800.
    expect(clampTaskPillOffset({ x: 120, y: 60 }, column, docked)).toEqual({ x: 120, y: 60 })
    // Pulled left/up past the column's own edges.
    expect(clampTaskPillOffset({ x: -50, y: -40 }, column, docked)).toEqual({ x: -2, y: -8 })
    // Pushed right/down past them.
    expect(clampTaskPillOffset({ x: 900, y: 900 }, column, docked)).toEqual({ x: 498, y: 720 })
  })

  it('docks a pill the column is too small to move', () => {
    const narrow = { left: 100, top: 40, right: 300, bottom: 60 }
    expect(clampTaskPillOffset({ x: 40, y: 40 }, narrow, docked)).toEqual({ x: 0, y: 0 })
  })

  it('treats a sub-pixel offset as docked', () => {
    expect(isTaskPillDocked(null)).toBe(true)
    expect(isTaskPillDocked({ x: 0, y: 0 })).toBe(true)
    expect(isTaskPillDocked({ x: 1.4, y: -1.9 })).toBe(true)
    expect(isTaskPillDocked({ x: 2, y: 0 })).toBe(false)
    expect(isTaskPillDocked({ x: 0, y: -120 })).toBe(false)
  })

  it('remembers the spot and forgets it when the pill is docked again', () => {
    const storage = memoryStorage()
    expect(readTaskPillOffset(storage)).toBeNull()
    writeTaskPillOffset({ x: 120, y: -30 }, storage)
    expect(readTaskPillOffset(storage)).toEqual({ x: 120, y: -30 })
    writeTaskPillOffset({ x: 0.5, y: 0 }, storage)
    expect(readTaskPillOffset(storage)).toBeNull()
    writeTaskPillOffset({ x: 40, y: 40 }, storage)
    writeTaskPillOffset(null, storage)
    expect(storage.values.has(TASK_PILL_OFFSET_STORAGE)).toBe(false)
  })

  it('ignores a stored value it cannot trust', () => {
    expect(readTaskPillOffset(memoryStorage('not json'))).toBeNull()
    expect(readTaskPillOffset(memoryStorage('{"x":1}'))).toBeNull()
    expect(readTaskPillOffset(memoryStorage('{"x":"2","y":3}'))).toBeNull()
    expect(readTaskPillOffset(memoryStorage('{"x":2,"y":3}'))).toEqual({ x: 2, y: 3 })
  })

  it('drags from the bar, clamps against the column, and does not click through', async () => {
    const pill = await readFile(new URL('./running-pill.tsx', import.meta.url), 'utf8')
    const shell = await readFile(new URL('../app-shell/chat-view.tsx', import.meta.url), 'utf8')

    expect(pill).toContain('onPointerDown={beginDrag}')
    expect(pill).toContain('onPointerMove={moveDrag}')
    expect(pill).toContain('onPointerUp={endDrag}')
    expect(pill).toContain('setPointerCapture?.(event.pointerId)')
    expect(pill).toContain('clampTaskPillOffset({ x: drag.originX + dx, y: drag.originY + dy }, drag.bounds, drag.docked)')
    // The drag threshold, and the press that ended a drag not opening the panel.
    expect(pill).toContain('Math.abs(dx) + Math.abs(dy) < 3')
    expect(pill).toContain('if (swallowClickRef.current) return')
    expect(pill).toContain("data-dragged={translate ? 'true' : 'false'}")
    // The reading header explicitly opts out of the floating variant's drag support.
    expect(shell).toContain('className="chat-header"')
    expect(shell).toContain('draggable={false}')
    expect(pill).toContain('if (!draggable || editing || event.button !== 0) return')

  })
})
