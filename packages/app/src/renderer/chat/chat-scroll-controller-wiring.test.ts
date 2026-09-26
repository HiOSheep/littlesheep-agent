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

  it('offers a reachable way back with a new-content hint', async () => {
    const view = await source('../app-shell/chat-view.tsx')
    const styles = await readRendererStyleSource()

    // It stays mounted for the length of its own exit, so the reader sees it drop back into the
    // composer instead of it vanishing on the frame the bottom is reached.
    expect(view).toContain('{jumpMounted && (')
    expect(view).toContain('className="chat-jump-to-latest"')
    expect(view).toContain("data-new-content={hasNewContent ? 'true' : 'false'}")
    expect(view).toContain('onClick={scrollToLatest}')
    // Icon-only: the arrow says the direction, the accessible name says the action and its state.
    expect(view).toContain('<JumpToLatestArrowIcon />')
    expect(view).toContain("aria-label={hasNewContent ? '有新内容，回到最新' : '回到最新'}")
    // A circle, 3px above the input's visible top edge (the measured overlay height starts at the
    // composer shell, so its own top padding is subtracted), wearing the composer's own glass.
    expect(styles).toMatch(/\.chat-jump-to-latest\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*calc\(var\(--composer-overlay-height\) - var\(--composer-shell-inset-top\) \+ 3px\);[\s\S]*?left:\s*50%;/u)
    expect(styles).toMatch(/\.chat-jump-to-latest\s*\{[\s\S]*?width:\s*34px;[\s\S]*?height:\s*34px;[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*var\(--radius-circle\);[\s\S]*?backdrop-filter:\s*blur\(18px\) saturate\(135%\);/u)
    expect(styles).toMatch(/\.chat-jump-to-latest\s*\{[\s\S]*?color:\s*var\(--jump-to-latest-arrow\);[\s\S]*?background:\s*var\(--composer-surface\);/u)
    // The droplet grows out of the composer's top edge, and the hidden state is that same drop.
    expect(styles).toMatch(/\.chat-jump-to-latest\s*\{[\s\S]*?transform-origin:\s*50% calc\(100% \+ 3px\);/u)
    expect(styles).toMatch(/\.chat-jump-to-latest\[data-motion="entering"\],[\s\S]*?\.chat-jump-to-latest\[data-motion="exiting"\]\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*translateX\(-50%\) translateY\(14px\) scale\(0\.18\);/u)
    expect(styles).toContain('.chat-jump-to-latest[data-new-content="true"]::before')
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
