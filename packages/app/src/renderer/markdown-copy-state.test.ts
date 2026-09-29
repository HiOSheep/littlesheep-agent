// O4: the code block's own copy button must not swallow a refused clipboard write.
//
// It used to be `async function copy() { await navigator.clipboard.writeText(text); setCopied(true) }` with nothing
// around the await, so a refusal became an unhandled rejection and the success branch never ran - the user saw no
// difference between "nothing happened" and "the clipboard refused". These assertions fail against that shape.
//
// Written as .test.ts with source assertions on purpose: the failure state only exists after a click, which static
// markup cannot produce, and this repository has no DOM testing-library (its component tests render through
// react-dom/server's renderToStaticMarkup). The behavioural half is recorded as a gap rather than faked here.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('./Markdown.tsx', import.meta.url)), 'utf8')
const copyButton = source.slice(source.indexOf('function CopyButton('))

describe('code block copy state', () => {
  it('guards the clipboard write so a refusal cannot become an unhandled rejection', () => {
    expect(copyButton).toContain('try {')
    expect(copyButton).toMatch(/await navigator\.clipboard\.writeText\(text\)[\s\S]*catch\s*\{/)
  })

  it('reports success only after the write resolves', () => {
    const awaited = copyButton.indexOf('await navigator.clipboard.writeText(text)')
    const success = copyButton.indexOf("setCopyState('copied')")
    expect(awaited).toBeGreaterThanOrEqual(0)
    expect(success).toBeGreaterThan(awaited)
  })

  it('publishes a state a reader and a gate can both read', () => {
    expect(copyButton).toContain('data-copy-state={copyState}')
    // The refusal must be visible, not only in an attribute: a status line with a retry, the same shape the message
    // action row already uses.
    expect(copyButton).toMatch(/role="status"[\s\S]*复制失败/)
    expect(copyButton).toMatch(/重试/)
    expect(copyButton).toMatch(/复制失败，重试复制/)
  })
})
