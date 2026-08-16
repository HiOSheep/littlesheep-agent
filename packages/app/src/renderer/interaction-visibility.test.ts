import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'


async function readRendererFile(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}


function openingTag(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker)
  expect(markerIndex, `${marker} should exist`).toBeGreaterThanOrEqual(0)
  const start = source.lastIndexOf('<', markerIndex)
  const end = source.indexOf('>', markerIndex)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(markerIndex)
  return source.slice(start, end + 1)
}


describe('interaction surface visibility', () => {
  it('keeps hidden menus and private disclosures out of pointer and focus routing', async () => {
    const contracts = [
      ['./composer/runtime-picker.tsx', 'className={`runtime-menu-shell'],
      ['./composer/add-menu.tsx', 'className="add-menu-panel"'],
      ['./composer/mode-picker.tsx', 'className="model-picker-panel option-picker-panel mode-picker-panel"'],
      ['./chat/agent-tool-row.tsx', 'className={`agent-tool-details-panel disclosure-panel'],
      ['./TraceCard.tsx', 'className={`trace-body disclosure-panel'],
      ['./sidebar/feature-panel.tsx', 'className={`sidebar-feature-panel'],
      ['./sidebar/project-creator.tsx', 'className={`project-creator-layer'],
      ['./sidebar/project-creator.tsx', 'className={`project-create-panel'],
      ['./workspace/panel.tsx', 'className="workspace-panel-contents"'],
    ] as const

    for (const [path, marker] of contracts) {
      const source = await readRendererFile(path)
      const tag = openingTag(source, marker)
      expect(tag, `${path}: ${marker} needs aria-hidden`).toContain('aria-hidden=')
      expect(tag, `${path}: ${marker} needs inert`).toContain("inert: ''")
    }

    const assistantTurn = await readRendererFile('./chat/assistant-turn.tsx')
    expect(assistantTurn).toContain('className="agent-flow-details agent-reasoning-public-details"')
    expect(assistantTurn).not.toContain('agent-reasoning-toggle')
    expect(assistantTurn).not.toContain('agent-flow-details-panel')
  })

  it('prevents inert descendants and closed runtime panels from restoring pointer hits', async () => {
    const styles = await readRendererFile('./styles.css')
    expect(styles).toMatch(/\[inert\],\s*\[inert\] \*\s*\{\s*pointer-events: none !important;/u)
    expect(styles).toMatch(/\.runtime-menu-shell:not\(\.open\)[\s\S]*?\.runtime-picker-panel[\s\S]*?pointer-events: none;[\s\S]*?visibility: hidden;/u)
    expect(styles).toMatch(/\.disclosure-panel:not\(\.open\)\s*\{\s*pointer-events: none;/u)
  })

  it('keeps long message content from creating a chat-wide horizontal scrollbar', async () => {
    const styles = await readRendererFile('./styles.css')
    expect(styles).toMatch(/\.messages\s*\{[\s\S]*?overflow-x: hidden;[\s\S]*?overflow-y: auto;/u)
    expect(styles).toMatch(/\.markdown pre > code\s*\{[\s\S]*?white-space: pre-wrap;[\s\S]*?overflow-wrap: anywhere;/u)

    const verticalOnlySurfaces = [...styles.matchAll(/([^{}]+)\{([^{}]*overflow-y:\s*(?:auto|scroll)[^{}]*)\}/gu)]
      .filter((match) => !match[2]?.includes('overflow-x:'))
      .map((match) => match[1]?.trim())
    expect(verticalOnlySurfaces).toEqual([])
  })

  it('disables generic exiting overlays while keeping the reversible settings transition explicit', async () => {
    const presence = await readRendererFile('./ui/presence.tsx')
    const overlays = await readRendererFile('./app-shell/overlays-view.tsx')
    expect(presence).toContain('interactiveDuringExit = false')
    expect(presence).toContain("interactionHidden ? { inert: '' } : {}")
    expect(overlays).toContain('interactiveDuringExit')
  })
})
