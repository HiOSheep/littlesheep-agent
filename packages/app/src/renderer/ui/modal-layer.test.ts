import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createModalLayerRegistry, nextFocusIndex } from './modal-layer'

function readRendererFile(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

describe('modal layer arbitration', () => {
  it('gives Escape to the topmost layer only', () => {
    const layers = createModalLayerRegistry()
    layers.push('page')
    layers.push('dialog')

    expect(layers.isTop('dialog')).toBe(true)
    expect(layers.isTop('page')).toBe(false)
    expect(layers.top()).toBe('dialog')
    expect(layers.depth()).toBe(2)

    layers.remove('dialog')
    expect(layers.isTop('page')).toBe(true)
  })

  it('keeps one entry per layer id so a re-run effect cannot stack duplicates', () => {
    const layers = createModalLayerRegistry()
    layers.push('dialog')
    layers.push('dialog')

    expect(layers.depth()).toBe(1)

    layers.remove('dialog')
    expect(layers.top()).toBeNull()
    // Removing an unregistered layer is a no-op, not a crash.
    layers.remove('dialog')
    expect(layers.depth()).toBe(0)
  })

  it('stays quiet with no layers', () => {
    const layers = createModalLayerRegistry()
    expect(layers.isTop('anything')).toBe(false)
    expect(layers.top()).toBeNull()
  })
})

describe('tab focus cycling', () => {
  it('wraps at both ends of the scope', () => {
    expect(nextFocusIndex(3, 2, false)).toBe(0)
    expect(nextFocusIndex(3, 0, true)).toBe(2)
  })

  it('moves one step inside the scope', () => {
    expect(nextFocusIndex(3, 0, false)).toBe(1)
    expect(nextFocusIndex(3, 2, true)).toBe(1)
  })

  it('enters the scope at its first or last stop', () => {
    expect(nextFocusIndex(3, -1, false)).toBe(0)
    expect(nextFocusIndex(3, -1, true)).toBe(2)
  })

  it('reports no target for an empty scope', () => {
    expect(nextFocusIndex(0, -1, false)).toBe(-1)
    expect(nextFocusIndex(0, 0, true)).toBe(-1)
  })
})

describe('modal surfaces wiring', () => {
  it('arbitrates Escape, contains Tab and restores focus', async () => {
    const surface = await readRendererFile('./modal-surface.ts')

    expect(surface).toContain('modalLayers.isTop(id)')
    expect(surface).toContain("event.key !== 'Escape' || event.defaultPrevented || event.isComposing")
    expect(surface).toContain("if (event.key !== 'Tab') return")
    expect(surface).toContain('previouslyFocused?.isConnected')
    expect(surface).toContain('modalLayers.remove(id)')
    // A surface that only animates out must not take keys.
    expect(surface).toContain('if (!active) return')
  })

  it('keeps the approval prompt rejecting on Escape and off the authorizing button', async () => {
    const prompt = await readRendererFile('../approval/prompt.tsx')

    expect(prompt).toContain("onEscape: () => onResolve('deny')")
    expect(prompt).toContain('initialFocusRef: headingRef')
    expect(prompt).toContain('active={Boolean(prompt)}')
    expect(prompt).toContain('tabIndex={-1}')
    // No action button may hold the initial focus, or a held Enter would grant.
    expect(prompt).not.toContain('autoFocus')
  })

  it('keeps closing the recovery dialog separate from abandoning a task', async () => {
    const recovery = await readRendererFile('../runtime-recovery/checkpoint-recovery.tsx')

    expect(recovery).toContain('onEscape: recovery.dismiss')
    expect(recovery).toContain('active: recovery.visible')
    expect(recovery).not.toContain('onEscape: recovery.abandonSelected')
    expect(recovery).toContain('ref={closeRef}')
  })

  it('runs the shared confirmation layer through the same modal rules', async () => {
    const confirm = await readRendererFile('./danger-confirm.tsx')

    expect(confirm).toContain('useModalSurface(dialogRef')
    expect(confirm).toContain('if (!busy) onCancel()')
    expect(confirm).toContain('initialFocusRef: cancelRef')
    expect(confirm).toContain('role="alertdialog"')
  })

  it('keeps the full-access warning above the picker with its red action', async () => {
    const picker = await readRendererFile('../composer/mode-picker.tsx')

    expect(picker).toContain('useModalSurface(dialogRef')
    expect(picker).toContain('onEscape: onCancel')
    expect(picker).toContain('approval-action primary danger')
    expect(picker).not.toContain("onKeyDown={(event) => {\n          if (event.key === 'Escape')")
  })

  it('gives page-level Escape to the topmost layer instead of every listener', async () => {
    const [skills, channels, presence] = await Promise.all([
      readRendererFile('../MemorySkills.tsx'),
      readRendererFile('../ChannelConnections.tsx'),
      readRendererFile('./presence.tsx'),
    ])

    for (const source of [skills, channels]) {
      expect(source).toContain('useEscapeScope(')
      expect(source).not.toContain("if (e.key === 'Escape') onClose()")
    }
    expect(presence).toContain('useEscapeScope(() => onDismissRef.current(), active)')
    expect(presence).not.toContain("if (event.key === 'Escape') onDismissRef.current()")
  })
})
