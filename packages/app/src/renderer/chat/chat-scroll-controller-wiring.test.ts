// UX-19 wiring probe: scroll ownership, the reader's anchor and the way back to the newest
// message are Renderer behaviours that a node test cannot click. They are asserted at the
// source level (the pure arithmetic is covered in chat-scroll-anchor.test.ts) so the wiring
// cannot silently drift back into the view or lose the "reader is away" branch.
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { readRendererStyleSource } from '../style-source-test-utils'

async function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

describe('chat scroll controller wiring', () => {
  it('keeps scroll ownership in the controller hook, not in the transcript view', async () => {
    const view = await source('../app-shell/chat-view.tsx')
    const hook = await source('./use-chat-scroll-controller.ts')

    expect(view).toContain("import { useChatScrollController } from '../chat/use-chat-scroll-controller'")
    expect(view).toMatch(/useChatScrollController\(\{[\s\S]*?scrollRef,[\s\S]*?messages,[\s\S]*?sessionKey: currentSession,[\s\S]*?loadOlderMessages,/)
    expect(view).not.toContain('ResizeObserver')
    expect(view).not.toContain('layoutEffect')
    expect(hook).toContain('export function useChatScrollController')
    expect(hook).toContain('new ResizeObserver')
  })

  it('anchors a reader above the bottom to the message, not to their bottom gap', async () => {
    const hook = await source('./use-chat-scroll-controller.ts')

    expect(hook).toContain('anchor: selectChatVisibleAnchor(readChatAnchorProbes(container), previous.viewportHeight)')
    expect(hook).toContain('resolveAnchoredScrollTop(anchor, readChatAnchorProbes(container), container.scrollTop)')
    expect(hook).toMatch(/if \(repair\.stickToBottom\)[\s\S]*?resolveChatResizeScrollTop\(repair\.geometry, readChatScrollGeometry\(container\), true\)/)
    // A reflow keeps settling after the ResizeObserver notification, so the anchor is
    // re-applied on the bounded display-settle clock rather than measured once.
    expect(hook).toMatch(/const apply = \(timestamp: number\) => \{[\s\S]*?shouldContinueDisplaySettle\(settleState, timestamp\)/)
  })

  it('offers a reachable way to either end, with a new-content hint', async () => {
    const view = await source('../app-shell/chat-view.tsx')
    const styles = await readRendererStyleSource()

    // It stays mounted for the length of its own exit, so the reader sees it drop back into the
    // composer instead of it vanishing on the frame the bottom is reached.
    expect(view).toContain('{jumpMounted && (')
    expect(view).toContain('className="chat-jump-controls"')
    expect(view).toContain('className="chat-jump-button chat-jump-to-latest"')
    expect(view).toContain("data-new-content={hasNewContent ? 'true' : 'false'}")
    expect(view).toContain('onClick={scrollToLatest}')
    // Icon-only: the arrow says the direction, the accessible name says the action and its state.
    expect(view).toContain('<JumpToLatestArrow />')
    expect(view).toContain("aria-label={hasNewContent ? '有新内容，回到最新' : '回到最新'}")
    // The newest end is the only droplet: the way back to the first line is the rail and Ctrl+Home,
    // and a second circle in the transcript was one control too many (asked for 2026-10-03).
    expect(view).toContain('const showJumpControls = readingAway')
    expect(view).not.toContain('chat-jump-to-top')
    expect(view).not.toContain('JumpToTopArrow')
    expect(view).not.toContain('showTopJump')
    // The droplet keeps the end it was showing through its exit.
    expect(view).toContain('const offeredJumpRef = useRef({ latest: showJumpControls })')
    expect(view).toContain("data-motion={jumpMotion}")
    // A circle, centred, 16px above the input's visible top edge (the measured overlay height starts
    // at the composer shell, so its own top padding is subtracted). DSH floats it on the opaque card
    // surface with the panel elevation, next to the transcript rather than through it.
    expect(styles).toMatch(/\.chat-jump-controls\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*calc\(var\(--composer-overlay-height\) - var\(--composer-shell-inset-top\) \+ 16px\);[\s\S]*?left:\s*50%;/u)
    expect(styles).toMatch(/\.chat-jump-button\s*\{[\s\S]*?width:\s*34px;[\s\S]*?height:\s*34px;[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*var\(--radius-circle\);[\s\S]*?box-shadow:\s*var\(--chat-panel-elevation\);/u)
    expect(styles).toMatch(/\.chat-jump-button\s*\{[\s\S]*?color:\s*var\(--jump-to-latest-arrow\);[\s\S]*?background:\s*var\(--chat-card-fill\);/u)
    // The droplet grows out of the composer's top edge, and the hidden state is that same drop.
    expect(styles).toMatch(/\.chat-jump-controls\s*\{[\s\S]*?transform-origin:\s*50% calc\(100% \+ 16px\);/u)
    expect(styles).toMatch(/\.chat-jump-controls\[data-motion="entering"\],[\s\S]*?\.chat-jump-controls\[data-motion="exiting"\]\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*translateX\(-50%\) translateY\(14px\) scale\(0\.18\);/u)
    expect(styles).toContain('.chat-jump-to-latest[data-new-content="true"]::before')
  })

  it('gives a long conversation a rail that jumps to the message it names', async () => {
    const view = await source('../app-shell/chat-view.tsx')
    const controller = await source('./use-chat-scroll-controller.ts')
    const styles = await readRendererStyleSource()

    // The rail is the view's composition of a controller action and a pure helper; it does not
    // own scroll arithmetic.
    expect(view).toContain('const railTurns = useMemo(() => railEntries(messages), [messages])')
    expect(view).toContain('{railTurns.length >= RAIL_MIN_ENTRIES && (')
    expect(view).toContain('activeKey={activeTurnKey}')
    expect(view).toContain('onJump={scrollToTurn}')
    expect(view).toContain('<TurnRail')
    // No rail for a conversation that has not earned one, and none of the scroll work in the view.
    expect(view).not.toContain('scrollTop')
    expect(view).not.toContain('querySelectorAll')

    // The controller is the only place that reads the DOM for rail anchors, and it measures once
    // per layout change rather than once per scroll event.
    expect(controller).toContain('container.querySelectorAll<HTMLElement>(CHAT_RAIL_ANCHOR_SELECTOR)')
    expect(controller).toContain('resolveTurnJumpScrollTop(anchorTop, CHAT_TURN_JUMP_INSET, container.scrollHeight, container.clientHeight)')
    expect(controller).toContain('if (element.scrollHeight !== turnAnchorHeightRef.current) readTurnAnchors()')
    expect(controller).toMatch(/useLayoutEffect\(\(\) => \{\s*readTurnAnchors\(\)/)
    expect(controller).toContain('const userTurnCount = messages.reduce')

    expect(styles).toContain('.chat-turn-trigger')
    expect(styles).toContain('.chat-turn-panel')
    expect(styles).toContain('.chat-turn-list { min-height: 0; overflow-x: hidden; overflow-y: auto;')
    expect(styles).toContain('.chat-turn-entry[aria-current="true"]')
    const rail = await source('./turn-rail.tsx')
    expect(rail).toContain('aria-expanded={open}')
    expect(rail).toContain("event.key === 'Escape'")
    expect(rail).toContain("['ArrowDown', 'ArrowUp', 'Home', 'End']")
    expect(rail).toContain("document.addEventListener('pointerdown', dismiss)")
    expect(rail).toContain('onJump(turn.key); close()')
    expect(rail).toContain('filterNavigationTurns(turns, query)')
    expect(rail).toContain('aria-label="搜索轮次与内容摘要"')
  })

  it('reaches both ends from the keyboard without stealing a field\'s own Ctrl+Home', async () => {
    const view = await source('../app-shell/chat-view.tsx')

    expect(view).toContain('const action = chatJumpShortcut(event.key, event)')
    expect(view).toContain('if (action === \'top\') scrollToTop()')
    // A field keeps its own Ctrl+Home (the caret) unless it is an empty draft, where that caret
    // move is invisible; an open modal owns the keyboard.
    expect(view).toContain("target?.closest('input, textarea, select, [contenteditable=\"true\"], [contenteditable=\"\"]')")
    expect(view).toContain("if (field && !(field instanceof HTMLTextAreaElement && field.value === '')) return")
    expect(view).toContain('if (modalLayers.depth() > 0) return')
    expect(view).toContain("document.addEventListener('keydown', handleKeyDown)")
  })

  it('lets only the reader clear the reading flags', async () => {
    const hook = await source('./use-chat-scroll-controller.ts')

    // Both flags derive from the measured position; output arriving while away only sets them.
    expect(hook).toMatch(/const nearBottom = isChatNearBottom\(geometry, CHAT_STICKY_BOTTOM_THRESHOLD\)[\s\S]*?setReadingAway\(!nearBottom\)[\s\S]*?if \(nearBottom\) setHasNewContent\(false\)/)
    expect(hook).toMatch(/const grew = chatContentSignature\(messages\) !== observedContentRef\.current[\s\S]*?if \(shouldStickToBottom\)[\s\S]*?setHasNewContent\(false\)[\s\S]*?\} else \{[\s\S]*?if \(grew\) setHasNewContent\(true\)/)
    expect(hook).toMatch(/const scrollToLatest = useCallback\(\(\) => \{[\s\S]*?setReadingAway\(false\)[\s\S]*?setHasNewContent\(false\)/)
  })

  it('never re-pins a session on the arrival of a message', async () => {
    const hook = await source('./use-chat-scroll-controller.ts')

    // The session effect re-pins on purpose, but only for a real conversation change:
    // a message arriving, the draft gaining its id, and older history being prepended must
    // all leave the reader alone. The real window caught the draft case pulling a reader
    // who had scrolled up back to the bottom.
    expect(hook).toContain('const materializedDraft = !previousSessionKey && Boolean(sessionKey) && previousIdentity === identity')
    expect(hook).toContain('if (!firstRun && (!sessionChanged || materializedDraft)) return')
    expect(hook).not.toMatch(/\}, \[sessionKey, messageCount,/)
  })

  it('yields the settle loop to the reader but not to its own writes', async () => {
    const hook = await source('./use-chat-scroll-controller.ts')

    // A real-window run proved this is load-bearing: the anchored settle loop kept
    // re-applying the old reading position after "回到最新" was clicked, so the button
    // stayed visible and the chat never stayed at the bottom.
    expect(hook).toContain('writtenScrollTopRef.current = top')
    expect(hook).toMatch(/const written = writtenScrollTopRef\.current[\s\S]*?if \(written === null \|\| Math\.abs\(element\.scrollTop - written\) > 1\) cancelRepairFrames\(\)/)
    expect(hook).toMatch(/const scrollToLatest = useCallback\(\(\) => \{[\s\S]*?cancelRepairFrames\(\)/)
  })
})
