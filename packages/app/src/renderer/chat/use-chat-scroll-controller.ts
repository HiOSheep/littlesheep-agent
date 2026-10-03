// Chat scroll ownership: bottom stickiness, the reader's visible anchor, and the way back to
// the newest message. It lives beside the anchor arithmetic instead of inside the view, so
// chat-view.tsx stays a composition file and this state has one owner.
import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject, type UIEvent } from 'react'
import {
  CHAT_COMPOSER_OVERLAY_RESIZE_EVENT,
  CHAT_MESSAGE_ANCHOR_ATTRIBUTE,
  CHAT_STICKY_BOTTOM_THRESHOLD,
  CHAT_TURN_JUMP_INSET,
  didChatViewportResize,
  isChatNearBottom,
  readChatAnchorProbes,
  readChatScrollGeometry,
  resolveAnchoredScrollTop,
  resolveBottomAnchoredScrollTop,
  resolveChatResizeScrollTop,
  resolveTurnJumpScrollTop,
  selectChatVisibleAnchor,
  type ChatScrollGeometry,
  type ChatVisibleAnchor,
} from './chat-scroll-anchor'
import {
  CHAT_MESSAGE_CONTENT_SELECTOR,
  CHAT_RAIL_ANCHOR_SELECTOR,
  CHAT_TURN_RAIL_SELECTOR,
  activeTurnKey,
  railOverlapsText,
  type TurnAnchor,
} from './turn-navigation'
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
  /** The user turn the reader is looking at, or null when the conversation has none yet. */
  activeTurnKey: string | null
  /** True while the rail would sit on the transcript's own text (a compressed chat column). */
  railInTheWay: boolean
  scrollToLatest: () => void
  /** Jump to the first line of the conversation. */
  scrollToTop: () => void
  /** Put the user turn with this `data-message-key` at the top of the viewport. */
  scrollToTurn: (key: string) => void
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
  /** The scrollTop this hook wrote last, so `onScroll` can tell its own correction from the reader. */
  const writtenScrollTopRef = useRef<number | null>(null)
  /** Which conversation the transcript belongs to; see the session effect below. */
  const sessionKeyRef = useRef<string | undefined>(undefined)
  const transcriptIdentityRef = useRef<string | null | undefined>(undefined)
  /**
   * The user turns, measured once per turn added and per layout change instead of per scroll: a
   * long transcript would otherwise read one rect per turn on every scroll event.
   */
  const turnAnchorCacheRef = useRef<TurnAnchor[]>([])
  /** The `scrollHeight` those anchors were measured at; content growth invalidates them. */
  const turnAnchorHeightRef = useRef(-1)
  const activeTurnKeyRef = useRef<string | null>(null)
  const [railInTheWay, setRailInTheWay] = useState(false)
  const [readingAway, setReadingAway] = useState(false)
  const [hasNewContent, setHasNewContent] = useState(false)
  const [activeTurn, setActiveTurn] = useState<string | null>(null)

  const rememberScrollGeometry = useCallback((container: HTMLElement) => {
    scrollGeometryRef.current = readChatScrollGeometry(container)
  }, [])

  /**
   * A repair loop writes scrollTop on every frame, and Chromium answers with a scroll
   * event for each write. Remembering the value we wrote is what lets `onScroll` tell a
   * real user scroll from our own correction: the loop must survive its own writes and
   * must yield immediately to the reader.
   */
  const writeScrollTop = useCallback((container: HTMLElement, top: number) => {
    writtenScrollTopRef.current = top
    container.scrollTop = top
  }, [])

  const cancelRepairFrames = useCallback(() => {
    if (repairFrameRef.current === null) return
    window.cancelAnimationFrame(repairFrameRef.current)
    repairFrameRef.current = null
  }, [])

  /**
   * Measure every user turn in the transcript's own scroll coordinates. The DOM read lives here;
   * `turn-navigation.ts` decides what the measurements mean.
   */
  const readTurnAnchors = useCallback(() => {
    const container = scrollRef.current
    if (!container) {
      turnAnchorCacheRef.current = []
      return
    }
    const viewportTop = container.getBoundingClientRect().top
    const scrollTop = container.scrollTop
    turnAnchorCacheRef.current = Array.from(
      container.querySelectorAll<HTMLElement>(CHAT_RAIL_ANCHOR_SELECTOR),
    ).map((element) => ({
      key: element.getAttribute(CHAT_MESSAGE_ANCHOR_ATTRIBUTE) ?? '',
      top: element.getBoundingClientRect().top - viewportTop + scrollTop,
    }))
    turnAnchorHeightRef.current = container.scrollHeight
  }, [scrollRef])

  /** Publish the active turn only when it changes: this runs on every scroll event. */
  const syncActiveTurn = useCallback((container: HTMLElement) => {
    const next = activeTurnKey(turnAnchorCacheRef.current, container.scrollTop)
    if (next === activeTurnKeyRef.current) return
    activeTurnKeyRef.current = next
    setActiveTurn(next)
  }, [])

  /**
   * Whether the rail is covering the transcript's own text. Measured rather than guessed from a
   * width: the content column is centred inside the scroll container, so the gap between the rail's
   * right edge and the column's left edge is the whole answer (a compressed chat column leaves no
   * gutter, and the marks then sit on the first characters of every line).
   */
  const syncRailClearance = useCallback((container: HTMLElement) => {
    const rail = container.parentElement?.querySelector<HTMLElement>(CHAT_TURN_RAIL_SELECTOR) ?? null
    const content = container.querySelector<HTMLElement>(CHAT_MESSAGE_CONTENT_SELECTOR)
    const next = rail && content
      ? railOverlapsText(content.getBoundingClientRect().left - rail.getBoundingClientRect().right)
      : false
    setRailInTheWay((current) => (current === next ? current : next))
  }, [])

  /** The reader's own position decides both flags; nothing else may clear them. */
  const readReaderPosition = useCallback((container: HTMLElement): boolean => {
    const geometry = readChatScrollGeometry(container)
    const nearBottom = isChatNearBottom(geometry, CHAT_STICKY_BOTTOM_THRESHOLD)
    stickToBottomRef.current = nearBottom
    setReadingAway(!nearBottom)
    if (nearBottom) setHasNewContent(false)
    syncActiveTurn(container)
    return nearBottom
  }, [syncActiveTurn])

  const scrollToLatest = useCallback(() => {
    const container = scrollRef.current
    stickToBottomRef.current = true
    scrollRepairRef.current = null
    resizeRepairRef.current = null
    cancelRepairFrames()
    setReadingAway(false)
    setHasNewContent(false)
    if (!container) return
    writeScrollTop(container, Math.max(0, container.scrollHeight - container.clientHeight))
    syncActiveTurn(container)
    rememberScrollGeometry(container)
  }, [cancelRepairFrames, rememberScrollGeometry, scrollRef, syncActiveTurn, writeScrollTop])

  /**
   * Jump to the first line. The flags are not set here either: the position that was just written
   * is what decides them, so a conversation short enough to fit stays "at the bottom" while it is
   * also "at the top".
   */
  const scrollToTop = useCallback(() => {
    const container = scrollRef.current
    scrollRepairRef.current = null
    resizeRepairRef.current = null
    cancelRepairFrames()
    if (!container) return
    writeScrollTop(container, 0)
    readReaderPosition(container)
    rememberScrollGeometry(container)
  }, [cancelRepairFrames, readReaderPosition, rememberScrollGeometry, scrollRef, writeScrollTop])

  /** Put one user turn at the top of the viewport, the way the rail's marks ask for. */
  const scrollToTurn = useCallback((key: string) => {
    const container = scrollRef.current
    if (!container) return
    const target = Array.from(container.querySelectorAll<HTMLElement>(CHAT_RAIL_ANCHOR_SELECTOR))
      .find((element) => element.getAttribute(CHAT_MESSAGE_ANCHOR_ATTRIBUTE) === key)
    if (!target) return
    scrollRepairRef.current = null
    resizeRepairRef.current = null
    cancelRepairFrames()
    const anchorTop = target.getBoundingClientRect().top
      - container.getBoundingClientRect().top
      + container.scrollTop
    writeScrollTop(
      container,
      resolveTurnJumpScrollTop(anchorTop, CHAT_TURN_JUMP_INSET, container.scrollHeight, container.clientHeight),
    )
    // A jump is the reader's own move: re-derive every flag from where they landed instead of
    // assuming they arrived at the bottom.
    readReaderPosition(container)
    rememberScrollGeometry(container)
  }, [cancelRepairFrames, readReaderPosition, rememberScrollGeometry, scrollRef, writeScrollTop])

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
        if (Math.abs(container.scrollTop - nextTop) > 0.5) writeScrollTop(container, nextTop)
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
      writeScrollTop(container, Math.max(0, container.scrollHeight - container.clientHeight))
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

  // The rail lists user turns, so its measurements have to be refreshed when one appears (a send,
  // older history being prepended) or the conversation changes. Deliberately *not* on every
  // `messages` change: streaming replaces the array per chunk without adding a turn, and measuring
  // would read one rect per turn each time.
  const userTurnCount = messages.reduce((count, message) => (message.role === 'user' ? count + 1 : count), 0)
  useLayoutEffect(() => {
    readTurnAnchors()
    const container = scrollRef.current
    if (container) {
      syncActiveTurn(container)
      syncRailClearance(container)
    }
  }, [readTurnAnchors, scrollRef, sessionKey, syncActiveTurn, syncRailClearance, userTurnCount])

  useLayoutEffect(() => {
    // Opening a conversation starts at its newest message — but only a *conversation* change
    // may do that. Two measured cases must not:
    //   - the draft conversation gaining its persistent id while its transcript keeps
    //     streaming (real window: it pulled a reader who had scrolled up back to the bottom
    //     the moment the answer settled);
    //   - older history being prepended, which also changes the first message id.
    const identity = messages[0]?.id ?? null
    const previousIdentity = transcriptIdentityRef.current
    const previousSessionKey = sessionKeyRef.current
    const firstRun = previousIdentity === undefined
    const sessionChanged = previousSessionKey !== sessionKey
    const materializedDraft = !previousSessionKey && Boolean(sessionKey) && previousIdentity === identity
    transcriptIdentityRef.current = identity
    sessionKeyRef.current = sessionKey
    if (!firstRun && (!sessionChanged || materializedDraft)) return
    stickToBottomRef.current = true
    scrollRepairRef.current = null
    resizeRepairRef.current = null
    observedContentRef.current = chatContentSignature(messages)
    setReadingAway(false)
    setHasNewContent(false)
    const container = scrollRef.current
    if (container) {
      writeScrollTop(container, Math.max(0, container.scrollHeight - container.clientHeight))
      rememberScrollGeometry(container)
    }
  }, [sessionKey, messages, rememberScrollGeometry, scrollRef, writeScrollTop])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) return
    rememberScrollGeometry(container)
    if (typeof ResizeObserver === 'undefined') return

    const applyResizeRepair = (repair: ChatResizeRepair) => {
      if (repair.stickToBottom) {
        const nextTop = resolveChatResizeScrollTop(repair.geometry, readChatScrollGeometry(container), true)
        if (nextTop !== null && Math.abs(container.scrollTop - nextTop) > 0.5) {
          // ResizeObserver runs before the next paint. Applying the anchor here
          // keeps a bottom-pinned chat at the bottom from the first compressed
          // layout instead of visibly correcting it on a later timer.
          writeScrollTop(container, nextTop)
        }
        rememberScrollGeometry(container)
        return
      }
      if (!repair.anchor) return
      // The reader is above the bottom, so the message they were reading is the anchor.
      // A width change re-wraps every paragraph above them, and the container's own size
      // stops changing while its content is still settling — measuring once leaves the
      // tail of that reflow as a visible jump. Re-apply the anchor each frame until the
      // layout signature stops changing, using the same bounded settle as the
      // older-history repair.
      const { anchor } = repair
      let settleState: DisplaySettleState | null = null
      const readLayoutSignature = () => `${container.scrollHeight}:${container.clientHeight}`
      const apply = (timestamp: number) => {
        settleState ??= createDisplaySettleState(timestamp, readLayoutSignature())
        const nextTop = resolveAnchoredScrollTop(anchor, readChatAnchorProbes(container), container.scrollTop)
        if (nextTop !== null && Math.abs(container.scrollTop - nextTop) > 0.5) writeScrollTop(container, nextTop)
        rememberScrollGeometry(container)
        settleState = observeDisplaySettleFrame(settleState, timestamp, readLayoutSignature())
        repairFrameRef.current = shouldContinueDisplaySettle(settleState, timestamp)
          ? window.requestAnimationFrame(apply)
          : null
      }
      apply(window.performance.now())
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
      // A width change re-wraps every turn, so the rails' measurements are stale in the same
      // notification that made them stale — and it is also what decides whether the rail still has
      // its own gutter at all.
      readTurnAnchors()
      syncActiveTurn(container)
      syncRailClearance(container)
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
  }, [readTurnAnchors, rememberScrollGeometry, scrollRef, syncActiveTurn, syncRailClearance])

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    resizeRepairRef.current = null
    // A scroll event we did not write is the reader taking over: stop correcting
    // immediately instead of fighting them for the rest of the settle window.
    const written = writtenScrollTopRef.current
    writtenScrollTopRef.current = null
    if (written === null || Math.abs(element.scrollTop - written) > 1) cancelRepairFrames()
    // Content that grew under the reader (an image, a rendered diagram) moved every turn below it.
    // The height is the cheap witness for that: re-measure before reading the position so the
    // active mark and the flags describe the layout that is on screen now.
    if (element.scrollHeight !== turnAnchorHeightRef.current) readTurnAnchors()
    readReaderPosition(element)
    rememberScrollGeometry(element)
  }, [cancelRepairFrames, readReaderPosition, readTurnAnchors, rememberScrollGeometry])

  const onClickCapture = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (!target.closest('.assistant-process-trigger, .agent-flow-row[aria-expanded], .trace-toggle, .message-artifacts-more')) return
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

  return {
    readingAway,
    hasNewContent,
    activeTurnKey: activeTurn,
    railInTheWay,
    scrollToLatest,
    scrollToTop,
    scrollToTurn,
    prepareOlderHistoryLoad,
    onScroll,
    onClickCapture,
  }
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
