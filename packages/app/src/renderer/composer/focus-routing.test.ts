import { describe, expect, it } from 'vitest'
import {
  shouldFocusComposerInput,
  shouldTakeComposerFocus,
  type ComposerFocusTarget,
} from './focus-routing'

function targetWithMatch(match: boolean): EventTarget {
  return {
    closest: () => match ? {} : null,
  } as unknown as EventTarget
}

/** A DOM-less stand-in: only the two facts the decision reads. */
function element(options: {
  textEntry?: boolean
  documentRoot?: 'body' | 'documentElement'
} = {}): ComposerFocusTarget {
  const self: ComposerFocusTarget = {
    closest: (selector: string) => (
      options.textEntry && selector.includes('textarea') ? self : null
    ),
  }
  if (options.documentRoot === 'body') self.ownerDocument = { body: self }
  if (options.documentRoot === 'documentElement') self.ownerDocument = { documentElement: self }
  return self
}

describe('composer input focus routing', () => {
  it('focuses the textarea when a blank part of the composer is clicked', () => {
    expect(shouldFocusComposerInput(targetWithMatch(false))).toBe(true)
  })

  it('preserves the native action for controls and the textarea itself', () => {
    expect(shouldFocusComposerInput(targetWithMatch(true))).toBe(false)
  })

  it('ignores event targets that cannot be matched safely', () => {
    expect(shouldFocusComposerInput(null)).toBe(false)
    expect(shouldFocusComposerInput({} as EventTarget)).toBe(false)
  })
})

describe('who may take the composer caret', () => {
  const composer = element()

  it('takes it on launch while nothing else holds focus', () => {
    expect(shouldTakeComposerFocus({
      intent: 'launch',
      activeElement: element({ documentRoot: 'body' }),
      layerDepth: 0,
      target: composer,
    })).toBe(true)
    expect(shouldTakeComposerFocus({
      intent: 'launch',
      activeElement: null,
      layerDepth: 0,
      target: composer,
    })).toBe(true)
  })

  it('leaves a launch request alone once the user has focused something', () => {
    // The request is deferred by a frame; by then this is the user's own choice.
    expect(shouldTakeComposerFocus({
      intent: 'launch',
      activeElement: element(),
      layerDepth: 0,
      target: composer,
    })).toBe(false)
  })

  it('takes it for a new conversation even though the button holds focus', () => {
    expect(shouldTakeComposerFocus({
      intent: 'new-session',
      activeElement: element(),
      layerDepth: 0,
      target: composer,
    })).toBe(true)
  })

  it('leaves it where the user is typing', () => {
    // Renaming a conversation, searching sessions, editing a file: the caret is
    // in another text surface and a new conversation does not claim it.
    expect(shouldTakeComposerFocus({
      intent: 'new-session',
      activeElement: element({ textEntry: true }),
      layerDepth: 0,
      target: composer,
    })).toBe(false)
  })

  it('never takes it from a dialog, an approval prompt or an open popup', () => {
    for (const intent of ['launch', 'new-session'] as const) {
      expect(shouldTakeComposerFocus({
        intent,
        activeElement: element({ documentRoot: 'body' }),
        layerDepth: 1,
        target: composer,
      })).toBe(false)
    }
  })

  it('is a no-op when the composer already owns the caret', () => {
    expect(shouldTakeComposerFocus({
      intent: 'launch',
      activeElement: composer,
      layerDepth: 0,
      target: composer,
    })).toBe(true)
  })
})
