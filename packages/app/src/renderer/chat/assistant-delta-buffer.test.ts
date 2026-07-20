import { describe, expect, it, vi } from 'vitest'
import { createAssistantDeltaBuffer, type AssistantDeltaFrameScheduler } from './assistant-delta-buffer'


function controlledScheduler() {
  let callback: (() => void) | undefined
  const cancel = vi.fn(() => { callback = undefined })
  const schedule: AssistantDeltaFrameScheduler = (next) => {
    callback = next
    return cancel
  }
  return {
    schedule,
    cancel,
    run: () => {
      const next = callback
      callback = undefined
      next?.()
    },
  }
}


describe('assistant delta buffer', () => {
  it('coalesces provider chunks into one display-frame update', () => {
    const scheduler = controlledScheduler()
    const flushed: string[] = []
    const buffer = createAssistantDeltaBuffer((delta) => flushed.push(delta), scheduler.schedule)

    buffer.push('你')
    buffer.push('好')
    expect(flushed).toEqual([])

    scheduler.run()
    expect(flushed).toEqual(['你好'])
  })

  it('flushes pending text before a final replacement', () => {
    const scheduler = controlledScheduler()
    const flushed: string[] = []
    const buffer = createAssistantDeltaBuffer((delta) => flushed.push(delta), scheduler.schedule)

    buffer.push('draft')
    buffer.flush()

    expect(scheduler.cancel).toHaveBeenCalledOnce()
    expect(flushed).toEqual(['draft'])
    scheduler.run()
    expect(flushed).toEqual(['draft'])
  })

  it('drops provisional text when the approval gate fails', () => {
    const scheduler = controlledScheduler()
    const flushed: string[] = []
    const buffer = createAssistantDeltaBuffer((delta) => flushed.push(delta), scheduler.schedule)

    buffer.push('unapproved')
    buffer.clear()
    scheduler.run()

    expect(flushed).toEqual([])
  })
})
