// Turn navigation: what the rail lists, how each mark is drawn, which entry the reader is looking
// at, and the two ends the keyboard can reach. Pure functions only - `turn-rail.tsx` renders them
// and `use-chat-scroll-controller.ts` owns the scrolling they ask for.
//
// The rail exists because a long conversation had no way to move *inside* it (reported
// 2026-10-02): the transcript offered only "back to the newest message" and "load older history".
// It carries one mark per message in the transcript, and the two roles are told apart by colour
// (asked for on 2026-10-02, after two reference images): the reader's own messages are lighter than
// the answers. Length is not a role: it follows the reader's position, so the marks near where they
// are reading grow and the ones further away shrink, which is what makes a long transcript feel
// navigable at a glance.
import { CHAT_MESSAGE_ANCHOR_ATTRIBUTE } from './chat-scroll-anchor'
import type { ChatMessage } from './types'

/** A conversation with fewer entries than this does not need a rail; the ends' buttons cover it. */
export const RAIL_MIN_ENTRIES = 4

/** How much of a turn's first line the rail carries into its accessible name. */
export const TURN_LABEL_MAX_CHARS = 48

/** What an entry with no text (an attachment-only message) is called in the rail. */
export const RAIL_UNTITLED_LABEL = '（没有文字的轮次）'

/**
 * How many entries away from the reader still grow: the mark at distance 0 is the longest, and
 * everything at or beyond `RAIL_SCALE_STEPS` keeps the shortest length. Four steps reproduce the
 * falloff of the reference rail (1.00 / 0.77 / 0.54 / 0.38 / 0.23 of the active length).
 */
export const RAIL_SCALE_STEPS = 4

export interface RailEntry {
  /** Matches the rendered row's `data-message-key`, so a jump can find it in the DOM. */
  key: string
  role: 'user' | 'assistant'
  /** 1-based user turn this entry belongs to; an answer shares its question's turn. */
  turn: number
  /** The entry's first line, truncated: the rail's tooltip and its accessible name. */
  label: string
}

export interface TurnAnchor {
  key: string
  /** The row's top in the transcript's own scroll coordinates. */
  top: number
}

/** The anchor selector every rail query uses; one home for the attribute and the roles. */
export const CHAT_RAIL_ANCHOR_SELECTOR = `.message-with-meta[${CHAT_MESSAGE_ANCHOR_ATTRIBUTE}]`

/** The rail's own box and the transcript's centred content column, for the clearance measurement. */
export const CHAT_TURN_RAIL_SELECTOR = '.chat-turn-rail'
export const CHAT_MESSAGE_CONTENT_SELECTOR = '.messages-content'

/**
 * How much room the rail needs between its right edge and the transcript's text before it stops
 * being in the way. A compressed chat column has no gutter left, and the marks then sit on the
 * first characters of every line: below this gap the rail waits to be found instead of covering the
 * conversation (asked for 2026-10-03).
 */
export const CHAT_RAIL_CLEARANCE = 8

/** Whether the rail is sitting on the transcript's text, read from the gap between the two boxes. */
export function railOverlapsText(gap: number, clearance = CHAT_RAIL_CLEARANCE): boolean {
  return gap < clearance
}

/** The key a message is rendered with; the transcript and the rail must agree on it. */
export function messageKeyOf(message: ChatMessage, index: number): string {
  return message.id ?? `message-${index}`
}

/**
 * One line for the rail: the first non-empty line, whitespace collapsed, truncated. The reader is
 * looking for the shape of their own question, so the leading line is what identifies it.
 */
export function normalizeTurnLabel(text: string, maxChars = TURN_LABEL_MAX_CHARS): string {
  const firstLine = text
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .find((line) => line.length > 0) ?? ''
  if (firstLine.length <= maxChars) return firstLine
  return `${firstLine.slice(0, maxChars).trimEnd()}…`
}

/** Every message of a conversation, in order, ready for the rail. */
export function railEntries(messages: readonly ChatMessage[]): RailEntry[] {
  const entries: RailEntry[] = []
  let turn = 0
  messages.forEach((message, index) => {
    if (message.role === 'user') turn += 1
    entries.push({
      key: messageKeyOf(message, index),
      role: message.role,
      turn: Math.max(1, turn),
      label: normalizeTurnLabel(message.text) || RAIL_UNTITLED_LABEL,
    })
  })
  return entries
}

/**
 * Which length step a mark draws at: 0 for the entry the reader is at, up to `RAIL_SCALE_STEPS` for
 * everything further away. Anchored on the *index* rather than a measured distance, so the profile
 * is a function of the list the rail already has.
 */
export function railScaleStep(activeIndex: number, index: number, steps = RAIL_SCALE_STEPS): number {
  if (activeIndex < 0) return 0
  return Math.min(steps, Math.abs(index - activeIndex))
}

/**
 * The entry the reader is looking at: the last one whose top has reached the viewport's top edge
 * (within `probePx`). Anchors are in document order, so the first one still below the line ends the
 * search. Before the first entry reaches the top the first entry is the answer, which is what makes
 * the very top of the transcript light the first mark.
 */
export function activeTurnKey(
  anchors: readonly TurnAnchor[],
  scrollTop: number,
  probePx = 8,
): string | null {
  const first = anchors[0]
  if (!first) return null
  let active = first.key
  for (const anchor of anchors) {
    if (anchor.top - scrollTop <= probePx) active = anchor.key
    else break
  }
  return active
}

/** The label a mark carries for a screen reader, where colour cannot say which role it is. */
export function railEntryLabel(entry: RailEntry): string {
  return entry.role === 'user'
    ? `跳到你的第 ${entry.turn} 轮：${entry.label}`
    : `跳到第 ${entry.turn} 轮的回答：${entry.label}`
}

/** The shorter form the hover tip shows. */
export function railEntryTip(entry: RailEntry): string {
  return entry.role === 'user'
    ? `${entry.turn} · 你：${entry.label}`
    : `${entry.turn} · 回答：${entry.label}`
}

/**
 * Ctrl/Cmd+Home and Ctrl/Cmd+End are the two ends of the conversation. Everything else is not this
 * shortcut: no other modifier, and no plain Home/End (those belong to whatever has the caret).
 *
 * The caller still owns two refusals this function cannot see: a text field keeps its own Ctrl+Home
 * (the caret inside it), and an open modal owns the keyboard.
 */
export function chatJumpShortcut(
  key: string,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean },
): 'top' | 'latest' | null {
  if (!(modifiers.ctrlKey || modifiers.metaKey)) return null
  if (modifiers.altKey || modifiers.shiftKey) return null
  if (key === 'Home') return 'top'
  if (key === 'End') return 'latest'
  return null
}
