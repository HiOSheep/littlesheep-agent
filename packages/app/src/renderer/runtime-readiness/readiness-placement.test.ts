// Placement contract for the startup stage text (CS-09).
//
// A normal start states its stage next to the send control; only a failure may
// span the window. These assertions exist because the two surfaces are easy to
// merge back into one "loading bar", which is exactly what the taskbook rejects.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ComposerReadinessHint } from './composer-readiness-hint'
import { RuntimeReadinessNotice } from './runtime-readiness-notice'
import { readRendererStyleSource } from '../style-source-test-utils'
import type { RuntimeReadiness } from '../../shared/runtime-readiness-contracts'

// The test transform compiles JSX with the classic runtime, so components under
// test need the React global the same way `chat/assistant-turn.test.ts` does.
beforeAll(() => vi.stubGlobal('React', React))
afterAll(() => vi.unstubAllGlobals())

function readiness(state: RuntimeReadiness['state'], retryable = true): RuntimeReadiness {
  return { apiVersion: 1, state, phase: 'execution', reason: '正在准备运行能力', retryable }
}

function renderHint(state: RuntimeReadiness['state'] | undefined, reason: string | null): string {
  return renderToStaticMarkup(createElement(ComposerReadinessHint, {
    readiness: state ? readiness(state) : undefined,
    reason,
  }))
}

function renderNotice(state: RuntimeReadiness['state'], reason: string | null = '正在准备运行能力'): string {
  return renderToStaticMarkup(createElement(RuntimeReadinessNotice, { readiness: readiness(state), reason }))
}

describe('startup stage text placement', () => {
  it('states the Runtime sentence next to the send control while starting', () => {
    const html = renderHint('starting', '正在准备运行能力')
    expect(html).toContain('composer-readiness-hint')
    expect(html).toContain('正在准备运行能力')
    // The reason is Main's, and the hint never invents waiting copy of its own.
    expect(html).not.toContain('请稍候')
  })

  it('disappears as soon as execution is ready', () => {
    expect(renderHint('ready', null)).toBe('')
  })

  it('does not carry a failure: that case keeps the window-wide strip', () => {
    expect(renderHint('failed', '运行能力启动失败')).toBe('')
  })

  it('keeps the failure visible, with the retry Main allows', () => {
    const html = renderNotice('failed', 'runner: no provider')
    expect(html).toContain('runtime-readiness-notice failed')
    expect(html).toContain('运行能力启动失败：runner: no provider')
    expect(html).toContain('aria-live="assertive"')
    expect(html).toContain('runtime-readiness-retry')
  })

  it('does not span the window for a normal start', () => {
    expect(renderNotice('starting')).toBe('')
    expect(renderNotice('ready', null)).toBe('')
  })

  it('styles the normal hint locally and the failure surface window-wide', async () => {
    const styles = await readRendererStyleSource()
    const hint = /\.composer-readiness-hint\s*\{([^}]*)\}/u.exec(styles)?.[1] ?? ''
    expect(hint).toContain('text-overflow: ellipsis')
    expect(hint).not.toContain('position: fixed')
    expect(hint).not.toMatch(/(^|\s)(right|left):\s*0/u)

    const strip = /\.runtime-readiness-notice\s*\{([^}]*)\}/u.exec(styles)?.[1] ?? ''
    expect(strip).toContain('position: fixed')
    expect(strip).toMatch(/right:\s*0/u)
    expect(strip).toMatch(/left:\s*0/u)
  })

  it('mounts the hint inside the composer control row, next to the send actions', () => {
    const composer = readFileSync(
      fileURLToPath(new URL('../app-shell/composer-view.tsx', import.meta.url)),
      'utf8',
    )
    const hintAt = composer.indexOf('<ComposerReadinessHint')
    const sendAt = composer.indexOf('composer-run-actions')
    expect(hintAt).toBeGreaterThan(-1)
    expect(hintAt).toBeLessThan(sendAt)
    expect(composer).toContain('className="composer-right"')
  })
})
