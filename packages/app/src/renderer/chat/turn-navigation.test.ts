import { describe, expect, it } from 'vitest'
import {
  CHAT_MESSAGE_CONTENT_SELECTOR,
  CHAT_RAIL_ANCHOR_SELECTOR,
  CHAT_RAIL_CLEARANCE,
  CHAT_TURN_RAIL_SELECTOR,
  RAIL_MIN_ENTRIES,
  RAIL_SCALE_STEPS,
  RAIL_UNTITLED_LABEL,
  TURN_LABEL_MAX_CHARS,
  activeTurnKey,
  chatJumpShortcut,
  messageKeyOf,
  normalizeTurnLabel,
  railEntries,
  railEntryLabel,
  railEntryTip,
  railOverlapsText,
  railScaleStep,
  type TurnAnchor,
} from './turn-navigation'
import type { ChatMessage } from './types'

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { role: 'user', text: '你好', ...overrides }
}

describe('rail entries', () => {
  it('lists every message, keyed the way the transcript renders them', () => {
    const messages: ChatMessage[] = [
      message({ id: 'u1', text: '第一问' }),
      { role: 'assistant', id: 'a1', text: '答' },
      message({ text: '第二问' }),
    ]

    expect(railEntries(messages)).toEqual([
      { key: 'u1', role: 'user', turn: 1, label: '第一问' },
      { key: 'a1', role: 'assistant', turn: 1, label: '答' },
      { key: 'message-2', role: 'user', turn: 2, label: '第二问' },
    ])
    // The key has one derivation, shared with the row's `data-message-key`.
    expect(messageKeyOf(messages[0]!, 0)).toBe('u1')
    expect(messageKeyOf(messages[2]!, 2)).toBe('message-2')
  })

  it('gives an answer its question\'s turn number', () => {
    const entries = railEntries([
      message({ text: '问一' }),
      { role: 'assistant', text: '答一' },
      message({ text: '问二' }),
      { role: 'assistant', text: '答二' },
    ])
    expect(entries.map((entry) => entry.turn)).toEqual([1, 1, 2, 2])
  })

  it('names a turn by its first line, collapsed and bounded', () => {
    expect(normalizeTurnLabel('第一行\n第二行')).toBe('第一行')
    expect(normalizeTurnLabel('   多余   空白  ')).toBe('多余 空白')
    expect(normalizeTurnLabel('\n\n  只有第三行  ')).toBe('只有第三行')
    const long = 'x'.repeat(TURN_LABEL_MAX_CHARS + 20)
    const label = normalizeTurnLabel(long)
    expect(label.endsWith('…')).toBe(true)
    expect(label.length).toBe(TURN_LABEL_MAX_CHARS + 1)
  })

  it('still lists an entry that carries no text of its own', () => {
    expect(railEntries([message({ text: '   ' })])).toEqual([
      { key: 'message-0', role: 'user', turn: 1, label: RAIL_UNTITLED_LABEL },
    ])
  })

  it('queries the transcript with the selector it renders, both roles included', () => {
    expect(CHAT_RAIL_ANCHOR_SELECTOR).toBe('.message-with-meta[data-message-key]')
  })

  it('reads clearance from the gap between the rail and the text column', () => {
    // A compressed column leaves no gutter: the rail is then in the way and waits to be found.
    expect(railOverlapsText(-4)).toBe(true)
    expect(railOverlapsText(0)).toBe(true)
    expect(railOverlapsText(CHAT_RAIL_CLEARANCE - 1)).toBe(true)
    expect(railOverlapsText(CHAT_RAIL_CLEARANCE)).toBe(false)
    expect(railOverlapsText(25.3)).toBe(false)
    // The two boxes the measurement reads are named here, next to the anchor selector.
    expect(CHAT_TURN_RAIL_SELECTOR).toBe('.chat-turn-rail')
    expect(CHAT_MESSAGE_CONTENT_SELECTOR).toBe('.messages-content')
  })

  it('names the role in text, because colour cannot say it to a screen reader', () => {
    const [question, answer] = railEntries([message({ text: '问' }), { role: 'assistant', text: '答' }])
    expect(railEntryLabel(question!)).toBe('跳到你的第 1 轮：问')
    expect(railEntryLabel(answer!)).toBe('跳到第 1 轮的回答：答')
    expect(railEntryTip(question!)).toBe('1 · 你：问')
    expect(railEntryTip(answer!)).toBe('1 · 回答：答')
  })

  it('only shows a rail once the conversation has earned one', () => {
    expect(RAIL_MIN_ENTRIES).toBeGreaterThan(2)
    expect(railEntries([message({ text: 'a' }), { role: 'assistant', text: 'b' }])).toHaveLength(2)
    expect(RAIL_MIN_ENTRIES).toBeLessThanOrEqual(4)
  })
})

describe('rail length profile', () => {
  it('shrinks a mark by one step per entry away from the reader', () => {
    expect(railScaleStep(3, 3)).toBe(0)
    expect(railScaleStep(3, 2)).toBe(1)
    expect(railScaleStep(3, 4)).toBe(1)
    expect(railScaleStep(3, 7)).toBe(RAIL_SCALE_STEPS)
    // Everything past the last step keeps the shortest length instead of growing without bound.
    expect(railScaleStep(3, 90)).toBe(RAIL_SCALE_STEPS)
  })

  it('leaves the profile flat before the reader position is known', () => {
    expect(railScaleStep(-1, 5)).toBe(0)
  })
})

describe('active entry', () => {
  const anchors: TurnAnchor[] = [
    { key: 'a', top: 0 },
    { key: 'b', top: 400 },
    { key: 'c', top: 900 },
  ]

  it('is the last entry whose top has reached the viewport top', () => {
    expect(activeTurnKey(anchors, 0)).toBe('a')
    // The 8px probe tolerates an entry sitting just under the clip edge: it is the entry the reader
    // is on, not the one before it.
    expect(activeTurnKey(anchors, 391)).toBe('a')
    expect(activeTurnKey(anchors, 392)).toBe('b')
    expect(activeTurnKey(anchors, 1_400)).toBe('c')
  })

  it('is the first entry before any of them reaches the top, and the last one at the end', () => {
    // A transcript scrolled above its first entry (over-scroll) still lights the first mark.
    expect(activeTurnKey(anchors, -50)).toBe('a')
    // Far past the last entry: it stays the reader's position, not nothing.
    expect(activeTurnKey(anchors, 9_999)).toBe('c')
  })

  it('has no active entry when the conversation has none', () => {
    expect(activeTurnKey([], 0)).toBeNull()
  })
})

describe('end-of-conversation shortcut', () => {
  it('maps Ctrl/Cmd+Home and Ctrl/Cmd+End to the two ends', () => {
    expect(chatJumpShortcut('Home', { ctrlKey: true })).toBe('top')
    expect(chatJumpShortcut('End', { ctrlKey: true })).toBe('latest')
    expect(chatJumpShortcut('Home', { metaKey: true })).toBe('top')
    expect(chatJumpShortcut('End', { metaKey: true })).toBe('latest')
  })

  it('leaves plain Home/End and every other combination alone', () => {
    expect(chatJumpShortcut('Home', {})).toBeNull()
    expect(chatJumpShortcut('End', {})).toBeNull()
    expect(chatJumpShortcut('Home', { ctrlKey: true, shiftKey: true })).toBeNull()
    expect(chatJumpShortcut('End', { ctrlKey: true, altKey: true })).toBeNull()
    expect(chatJumpShortcut('PageDown', { ctrlKey: true })).toBeNull()
  })
})
