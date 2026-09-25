import { describe, expect, it } from 'vitest'
import {
  CODE_WRAP_STORAGE,
  codeWrapToggleLabel,
  readCodeWrapPreference,
  setCodeWrapPreference,
  subscribeCodeWrapPreference,
  writeCodeWrapPreference,
  type CodeWrapStorage,
} from './code-wrap-preference'

function memoryStorage(initial: Record<string, string> = {}): CodeWrapStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

describe('code wrap preference', () => {
  it('defaults to not wrapping when nothing was stored', () => {
    expect(readCodeWrapPreference(memoryStorage())).toBe(false)
  })

  it('persists the switch so every code block and the editor share one state', () => {
    const storage = memoryStorage()
    expect(writeCodeWrapPreference(true, storage)).toBe(true)
    expect(storage.values.get(CODE_WRAP_STORAGE)).toBe('on')
    expect(readCodeWrapPreference(storage)).toBe(true)
    expect(writeCodeWrapPreference(false, storage)).toBe(true)
    expect(readCodeWrapPreference(storage)).toBe(false)
  })

  it('labels the next action, not the current state', () => {
    expect(codeWrapToggleLabel(false)).toBe('开启自动换行')
    expect(codeWrapToggleLabel(true)).toBe('关闭自动换行')
  })

  it('notifies every mounted code surface when the shared switch changes', () => {
    const updates: string[] = []
    const removeChat = subscribeCodeWrapPreference(() => {
      updates.push(`chat:${readCodeWrapPreference()}`)
    })
    const removeWorkspace = subscribeCodeWrapPreference(() => {
      updates.push(`workspace:${readCodeWrapPreference()}`)
    })

    setCodeWrapPreference(true)
    expect(updates).toEqual(['chat:true', 'workspace:true'])
    setCodeWrapPreference(false)
    expect(updates.slice(2)).toEqual(['chat:false', 'workspace:false'])
    removeChat()
    removeWorkspace()
  })

  it('survives storage that throws instead of breaking the view', () => {
    const hostile: CodeWrapStorage = {
      getItem: () => {
        throw new Error('storage blocked')
      },
      setItem: () => {
        throw new Error('storage blocked')
      },
    }
    expect(readCodeWrapPreference(hostile)).toBe(false)
    expect(writeCodeWrapPreference(true, hostile)).toBe(false)
  })
})
