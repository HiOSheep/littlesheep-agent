// Chat scroll ownership: bottom stickiness, the reader's visible anchor, and the way back to
// the newest message. It lives beside the anchor arithmetic instead of inside the view, so
// chat-view.tsx stays a composition file and this state has one owner.
import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject, type UIEvent } from 'react'
import {
  CHAT_COMPOSER_OVERLAY_RESIZE_EVENT,
  CHAT_STICKY_BOTTOM_THRESHOLD,
  didChatViewportResize,
  isChatNearBottom,
  readChatAnchorProbes,
  readChatScrollGeometry,
  resolveAnchoredScrollTop,
  resolveBottomAnchoredScrollTop,
  resolveChatResizeScrollTop,
  selectChatVisibleAnchor,
  type ChatScrollGeometry,
  type ChatVisibleAnchor,
} from './chat-scroll-anchor'
import {
  WINDOW_RESIZE_END_EVENT,
  WINDOW_RESIZE_START_EVENT,
  WORKSPACE_NAVIGATOR_MOTION_END_EVENT,
  WORKSPACE_NAVIGATOR_MOTION_START_EVENT,
} from '../ui/resize'
import {
  createDisplaySettleState,
  observeDisplaySettleFrame,
  shouldContinueDisplaySettle,
  type DisplaySettleState,
} from '../ui/display-synced-settle'
import type { ChatMessage } from './types'

export interface ChatScrollControllerOptions {
  scrollRef: RefObject<HTMLDivElement | null>
  /**
   * The whole list, not only its length: streaming replaces the array without
   * changing its length, and following the bottom is exactly what must happen then.
   */
  messages: readonly ChatMessage[]
  /** Identity of the open session; changing it re-pins the new conversation to its bottom. */
  sessionKey: string | undefined
  loadOlderMessages: () => Promise<boolean | void>
}

export interface ChatScrollController {
  /** True while the reader is above the sticky-bottom band. */
  readingAway: boolean
  /** True when output arrived after the reader left the bottom. */
  hasNewContent: boolean
  scrollToLatest: () => void
  prepareOlderHistoryLoad: () => void
  onScroll: (event: UIEvent<HTMLDivElement>) => void
  onClickCapture: (event: MouseEvent<HTMLDivElement>) => void
}

interface ChatResizeRepair {
  geometry: ChatScrollGeometry
  stickToBottom: boolean
  anchor: ChatVisibleAnchor | null
}

export function useChatScrollController(options: ChatScrollControllerOptions): ChatScrollController {
  const { scrollRef, messages, sessionKey, loadOlderMessages } = options
  const stickToBottomRef = useRef(true)
  const scrollRepairRef = useRef<ChatScrollGeometry | null>(null)
  const scrollGeometryRef = useRef<ChatScrollGeometry | null>(null)
  const repairFrameRef = useRef<number | null>(null)
  const resizeRepairRef = useRef<ChatResizeRepair | null>(null)
  // A signature rather than a count: streaming grows the current message without
  // adding one, and that growth is exactly what a reader who scrolled away must
  // be told about.
  const observedContentRef = useRef(chatContentSignature(messages))
  const [readingAway, setReadingAway] = useState(false)
  const [hasNewContent, setHasNewContent] = useState(false)

  const rememberScrollGeometry = useCallback((container: HTMLElement) => {
    scrollGeometryRef.current = readChatScrollGeometry(container)
  }, [])

  /** The reader's own position decides both flags; nothing else may clear them. */
  const readReaderPosition = useCallback((container: HTMLElement): boolean => {
    const geometry = readChatScrollGeometry(container)
    const nearBottom = isChatNearBottom(geometry, CHAT_STICKY_BOTTOM_THRESHOLD)
    stickToBottomRef.current = nearBottom
    setReadingAway(!nearBottom)
    if (nearBottom) setHasNewContent(false)
    return nearBottom
  }, [])

  const scrollToLatest = useCallback(() => {
    const container = scrollRef.current
    stickToBottomRef.current = true
    scrollRepairRef.current = null
    resizeRepairRef.current = null
    setReadingAway(false)
    setHasNewContent(false)
    if (!container) return
    container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
    rememberScrollGeometry(container)
  }, [rememberScrollGeometry, scrollRef])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) return
    if (repairFrameRef.current !== null) window.cancelAnimationFrame(repairFrameRef.current)
    const previousGeometry = scrollGeometryRef.current
    resizeRepairRef.current = null
    const repair = scrollRepairRef.current
    scrollRepairRef.current = null
    if (repair) {
      let settleState: DisplaySettleState | null = null
      const readLayoutSignature = () => `${container.scrollHeight}:${container.clientHeight}`
      const apply = (timestamp: number) => {
        settleState ??= createDisplaySettleState(timestamp, readLayoutSignature())
        const nextTop = resolveBottomAnchoredScrollTop(repair, readChatScrollGeometry(container))
        if (Math.abs(container.scrollTop - nextTop) > 0.5) container.scrollTop = nextTop
        rememberScrollGeometry(container)
        settleState = observeDisplaySettleFrame(settleState, timestamp, readLayoutSignature())
        if (shouldContinueDisplaySettle(settleState, timestamp)) {
          // The callback timestamp is tied to Chromium's active display VSync.
          // Never replace this with a fixed frame count: that changes the
          // duration on 60/120/144/240 Hz displays.
          repairFrameRef.current = window.requestAnimationFrame(apply)
        } else {
          repairFrameRef.current = null
        }
      }
      apply(window.performance.now())
      observedContentRef.current = chatContentSignature(messages)
      return
    }
    const shouldStickToBottom = previousGeometry
      ? isChatNearBottom(previousGeometry, CHAT_STICKY_BOTTOM_THRESHOLD)
      : stickToBottomRef.current
    const grew = chatContentSignature(messages) !== observedContentRef.current
    observedContentRef.current = chatContentSignature(messages)
    if (shouldStickToBottom) {
      container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
      setReadingAway(false)
      setHasNewContent(false)
    } else {
      // Output arrived while the reader was away: say so instead of pulling them down.
      setReadingAway(true)
      if (grew) setHasNewContent(true)
    }
    rememberScrollGeometry(container)
  }, [messages, rememberScrollGeometry, scrollRef])

  useLayoutEffect(() => () => {
    if (repairFrameRef.current !== null) window.cancelAnimationFrame(repairFrameRef.current)
  }, [])

  useLayoutEffect(() => {
    // Opening a conversation starts at its newest message. The message count is
    // deliberately NOT a dependency: a new message must never re-pin a reader who
    // is reading above the bottom, which is the whole point of the anchor below.
    stickToBottomRef.current = true
    scrollRepairRef.current = null
    resizeRepairRef.current = null
    observedContentRef.current = chatContentSignature(messages)
    setReadingAway(false)
    setHasNewContent(false)
    const container = scrollRef.current
    if (container) {
      container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
      rememberScrollGeometry(container)
    }
  }, [sessionKey, rememberScrollGeometry, scrollRef])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) return
    rememberScrollGeometry(container)
    if (typeof ResizeObserver === 'undefined') return

    const applyResizeRepair = (repair: ChatResizeRepair) => {
      const current = readChatScrollGeometry(container)
      if (repair.stickToBottom) {
        const nextTop = resolveChatResizeScrollTop(repair.geometry, current, true)
        if (nextTop !== null && Math.abs(container.scrollTop - nextTop) > 0.5) {
          // ResizeObserver runs before the next paint. Applying the anchor here
          // keeps a bottom-pinned chat at the bottom from the first compressed
          // layout instead of visibly correcting it on a later timer.
          container.scrollTop = nextTop
        }
      } else if (repair.anchor) {
        // The reader is above the bottom, so the message they were reading is the
        // anchor. Width changes re-wrap every paragraph above them, and the old
        // bottom-gap arithmetic moved them by the viewport delta instead.
        const nextTop = resolveAnchoredScrollTop(repair.anchor, readChatAnchorProbes(container), container.scrollTop)
        if (nextTop !== null && Math.abs(container.scrollTop - nextTop) > 0.5) container.scrollTop = nextTop
      }
      rememberScrollGeometry(container)
    }

    const scheduleResizeRepair = (previous: ChatScrollGeometry) => {
      // Preserve the geometry from the first notification in this burst, but
      // apply the correction immediately. Delaying this until the transition
      // settles makes a bottom-pinned chat visibly jump after compression.
      resizeRepairRef.current ??= {
        geometry: previous,
        // The geometry captured immediately before the resize is the only
        // reliable indication of where the reader was. A stale sticky flag
        // must not turn an intentional reading gap into bottom pinning.
        stickToBottom: isChatNearBottom(previous),
        anchor: selectChatVisibleAnchor(readChatAnchorProbes(container), previous.viewportHeight),
      }
      const repair = resizeRepairRef.current
      if (repair) applyResizeRepair(repair)
      resizeRepairRef.current = null
    }

    let navigatorMotionGeometry: ChatScrollGeometry | null = null
    let windowResizeGeometry: ChatScrollGeometry | null = null
    const handleNavigatorMotionStart = () => {
      navigatorMotionGeometry ??= readChatScrollGeometry(container)
    }
    const handleNavigatorMotionEnd = () => {
      const previous = navigatorMotionGeometry
      navigatorMotionGeometry = null
      if (previous) scheduleResizeRepair(previous)
    }

    const handleWindowResizeStart = () => {
      windowResizeGeometry ??= readChatScrollGeometry(container)
      resizeRepairRef.current = null
    }
    const handleWindowResizeEnd = () => {
      const previous = windowResizeGeometry
      windowResizeGeometry = null
      if (previous) scheduleResizeRepair(previous)
    }

    const handleComposerOverlayResize = (event: Event) => {
      const previous = (event as CustomEvent<ChatScrollGeometry>).detail
      if (!previous) return
      scheduleResizeRepair(previous)
    }

    const observer = new ResizeObserver(() => {
      // Motion events provide the pre-transition geometry. Keep observing
      // while the panels animate so a pinned chat follows every compressed
      // layout before it can be painted at an intermediate position.
      const previous = navigatorMotionGeometry
        ?? windowResizeGeometry
        ?? scrollGeometryRef.current
      const current = readChatScrollGeometry(container)
      if (previous && didChatViewportResize(previous, current)) {
        scheduleResizeRepair(previous)
      }
      rememberScrollGeometry(container)
    })
    observer.observe(container)
    container.parentElement?.addEventListener(
      CHAT_COMPOSER_OVERLAY_RESIZE_EVENT,
      handleComposerOverlayResize,
    )
    window.addEventListener(WORKSPACE_NAVIGATOR_MOTION_START_EVENT, handleNavigatorMotionStart)
    window.addEventListener(WORKSPACE_NAVIGATOR_MOTION_END_EVENT, handleNavigatorMotionEnd)
    window.addEventListener(WINDOW_RESIZE_START_EVENT, handleWindowResizeStart)
    window.addEventListener(WINDOW_RESIZE_END_EVENT, handleWindowResizeEnd)
    return () => {
      observer.disconnect()
      container.parentElement?.removeEventListener(
        CHAT_COMPOSER_OVERLAY_RESIZE_EVENT,
        handleComposerOverlayResize,
      )
      window.removeEventListener(WORKSPACE_NAVIGATOR_MOTION_START_EVENT, handleNavigatorMotionStart)
      window.removeEventListener(WORKSPACE_NAVIGATOR_MOTION_END_EVENT, handleNavigatorMotionEnd)
      window.removeEventListener(WINDOW_RESIZE_START_EVENT, handleWindowResizeStart)
      window.removeEventListener(WINDOW_RESIZE_END_EVENT, handleWindowResizeEnd)
      resizeRepairRef.current = null
    }
  }, [rememberScrollGeometry, scrollRef])

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    resizeRepairRef.current = null
    readReaderPosition(element)
    rememberScrollGeometry(element)
  }, [readReaderPosition, rememberScrollGeometry])

  const onClickCapture = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (!target.closest('.agent-tool-row, .trace-toggle')) return
    // Expanding a nested disclosure is a reading action, not new-message
    // arrival. Leave scrollTop untouched while CSS animates the content height.
    stickToBottomRef.current = false
    setReadingAway(true)
  }, [])

  const prepareOlderHistoryLoad = useCallback(() => {
    const container = scrollRef.current
    if (container) scrollRepairRef.current = readChatScrollGeometry(container)
    void loadOlderMessages().then((loaded) => {
      if (!loaded) scrollRepairRef.current = null
    })
  }, [loadOlderMessages, scrollRef])

  return { readingAway, hasNewContent, scrollToLatest, prepareOlderHistoryLoad, onScroll, onClickCapture }
}

/**
 * What counts as "the transcript produced something new": a message was added, or
 * the open turn's text grew. Deliberately cheap and non-cryptographic — it only
 * decides whether to show a hint.
 */
function chatContentSignature(messages: readonly ChatMessage[]): string {
  if (messages.length === 0) return '0'
  const last = messages[messages.length - 1]
  return `${messages.length}:${last?.id ?? ''}:${last?.text?.length ?? 0}`
}
