import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_TAB_LABEL_SCROLL_SPEED_PX_PER_SECOND,
  resolveWorkspaceTabLabelMotion,
} from './tab-label-motion'

describe('workspace tab label motion', () => {
  it('does not move labels that fit their viewport', () => {
    expect(resolveWorkspaceTabLabelMotion(120, 120)).toEqual({
      durationMs: 0,
      offsetPx: 0,
      overflowPx: 0,
    })
    expect(resolveWorkspaceTabLabelMotion(120, 121)).toEqual({
      durationMs: 0,
      offsetPx: 0,
      overflowPx: 0,
    })
  })

  it('moves exactly to the label end at one constant speed', () => {
    const shortOverflow = resolveWorkspaceTabLabelMotion(100, 132)
    const longOverflow = resolveWorkspaceTabLabelMotion(100, 164)

    expect(shortOverflow).toEqual({
      durationMs: 1_000,
      offsetPx: -32,
      overflowPx: 32,
    })
    expect(longOverflow).toEqual({
      durationMs: 2_000,
      offsetPx: -64,
      overflowPx: 64,
    })
    expect(longOverflow.overflowPx / (longOverflow.durationMs / 1_000)).toBe(
      WORKSPACE_TAB_LABEL_SCROLL_SPEED_PX_PER_SECOND,
    )
  })

  it('shares one overflow renderer across workspace and sidebar names', async () => {
    const component = await readFile(new URL('../ui/overflowing-label.tsx', import.meta.url), 'utf8')
    const tabStrip = await readFile(new URL('./tab-strip.tsx', import.meta.url), 'utf8')
    const sessionRow = await readFile(new URL('../sidebar/session-row.tsx', import.meta.url), 'utf8')
    const projectSection = await readFile(new URL('../sidebar/project-section.tsx', import.meta.url), 'utf8')

    expect(component).toContain('export function OverflowingLabel')
    expect(component).toContain('new ResizeObserver(updateMotion)')
    expect(component).toContain("viewport.classList.toggle('is-overflowing'")
    expect(tabStrip).toContain('<OverflowingLabel')
    expect(sessionRow).toContain('<OverflowingLabel')
    expect(projectSection).toContain('<OverflowingLabel')
  })
})
