// V3 (状态与反馈视觉): a disabled two-part control must be able to say why it is disabled.
//
// `disabledReason` has existed since the component was built, but no caller passed one, so a greyed-out control could
// not explain itself. The first three cases pin the component's contract; the fourth is the one that would have caught
// the gap, because it fails while no call site supplies a reason.
//
// Harness copied from the repository's own component tests: react-dom/server's renderToStaticMarkup and assertions on
// the produced markup. There is no DOM testing-library here, and this file is .test.ts rather than .tsx because the
// vitest include is `*.test.ts` - a .tsx test would silently never run.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SplitButton } from './split-button'

// The test transform uses the classic JSX runtime, so any JSX inside the imported component resolves to a global
// React. The repository's own component test says the same thing; without this the component throws ReferenceError.
;(globalThis as { React?: typeof React }).React = React

const base = {
  icon: React.createElement('span'),
  label: '终端 Shell：没有可用的 Shell',
  primaryTip: '用 没有可用的 Shell 新建终端',
  menuLabel: '选择终端 Shell',
  items: [],
  onPrimary: vi.fn(),
}

const REASON = '本机没有可用的终端 Shell：pwsh：未安装'

describe('split button disabled reasons', () => {
  it('puts the reason it was given into the markup', () => {
    const html = renderToStaticMarkup(React.createElement(SplitButton, { ...base, disabled: true, disabledReason: REASON }))
    expect(html).toContain(REASON)
  })

  it('invents nothing when no reason is supplied', () => {
    const html = renderToStaticMarkup(React.createElement(SplitButton, { ...base, disabled: true }))
    expect(html).not.toContain(REASON)
    expect(html).not.toContain('本机没有可用的终端 Shell')
  })

  it('says it is busy rather than inventing a reason, in the state the app actually reaches', () => {
    // Busy and "no shell available" are mutually exclusive at the call site: the reason only exists when nothing is
    // available, and then nothing can be running. So this pins the reachable state - busy, no reason - and asserts the
    // busy sentence wins and no reason is fabricated.
    const html = renderToStaticMarkup(React.createElement(SplitButton, { ...base, busy: true }))
    expect(html).toContain('正在执行')
    expect(html).not.toContain(REASON)
    expect(html).not.toContain('本机没有可用的终端 Shell')
  })

  it('is supplied by the call site that can actually be disabled, and by no other', () => {
    const here = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    expect(here('../workspace/terminal-shell-picker.tsx')).toContain('disabledReason=')
    // The other call site has no disabled state at all, so it must not grow a meaningless reason.
    expect(here('../workspace/preview-actions.tsx')).not.toContain('disabledReason=')
  })
})
