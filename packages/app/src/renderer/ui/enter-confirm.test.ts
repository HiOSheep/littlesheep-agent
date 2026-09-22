import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  createImeCompositionState,
  IME_PROCESS_KEY_CODE,
  resolveEnterAction,
  type EnterKeyEvent,
} from './enter-confirm'

function press(key: string, init: Partial<EnterKeyEvent> = {}): EnterKeyEvent {
  return { key, shiftKey: false, keyCode: 13, isComposing: false, ...init }
}

describe('Enter confirmation rules', () => {
  it('confirms on a plain Enter and keeps the line break on Shift+Enter', () => {
    expect(resolveEnterAction(press('Enter'))).toBe('confirm')
    expect(resolveEnterAction(press('Enter', { shiftKey: true }))).toBe('line-break')
  })

  it('never confirms while an input method composes', () => {
    expect(resolveEnterAction(press('Enter', { isComposing: true }))).toBe('ignore')
    expect(resolveEnterAction(press('Enter', { isComposing: true, shiftKey: true }))).toBe('ignore')
  })

  it('ignores the legacy composition keydown that keeps reporting 229', () => {
    expect(resolveEnterAction(press('Enter', { keyCode: IME_PROCESS_KEY_CODE }))).toBe('ignore')
  })

  it('ignores Enter while composition is pending between composition events', () => {
    const composition = createImeCompositionState()
    composition.start()
    expect(resolveEnterAction(press('Enter'), composition.composing)).toBe('ignore')
    composition.end()
    expect(resolveEnterAction(press('Enter'), composition.composing)).toBe('confirm')
  })

  it('ignores keys other than Enter so the textarea keeps its own behavior', () => {
    for (const key of ['a', 'Process', 'Escape', 'Backspace', 'ArrowUp']) {
      expect(resolveEnterAction(press(key)), key).toBe('ignore')
    }
  })

  it('sends once for the Enter that follows an IME confirmation', () => {
    const composition = createImeCompositionState()
    const confirmations: number[] = []
    let step = 0

    // Microsoft Pinyin: Enter accepts the candidate word (keydown reports the
    // composition), the next plain Enter is the user's send.
    composition.start()
    if (resolveEnterAction(press('Enter', { isComposing: true }), composition.composing) === 'confirm') {
      confirmations.push(step)
    }
    composition.end()
    step += 1
    if (resolveEnterAction(press('Enter'), composition.composing) === 'confirm') {
      confirmations.push(step)
    }

    expect(confirmations).toEqual([1])
  })
})

async function readRendererFile(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

describe('Enter confirmation wiring', () => {
  it('routes the composer send through the shared rule with composition state', async () => {
    const composer = await readRendererFile('../app-shell/composer-view.tsx')
    expect(composer).toContain("from '../ui/enter-confirm'")
    expect(composer).toContain('createImeCompositionState()')
    expect(composer).toContain('resolveEnterAction(event.nativeEvent')
    expect(composer).toContain('onCompositionStart')
    expect(composer).toContain('onCompositionEnd')
    // A raw Enter check would send while the IME is still composing.
    expect(composer).not.toContain("event.key === 'Enter' && !event.shiftKey")
  })

  it('routes the project-name submit through the same rule', async () => {
    const creator = await readRendererFile('../sidebar/project-creator.tsx')
    expect(creator).toContain("from '../ui/enter-confirm'")
    expect(creator).toContain('resolveEnterAction(event.nativeEvent')
    expect(creator).toContain('onCompositionStart')
  })
})
