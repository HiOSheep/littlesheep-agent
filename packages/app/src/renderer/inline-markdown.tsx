// Inline Markdown for single-line activity labels.
//
// These labels are short, one line, and occasionally carry emphasis or an inline
// code span. Routing them through the full parser would make the Markdown plugin
// chain reachable from the entry path for a one-line label, so the constructs
// that actually appear are handled by a bounded, dependency-free scanner.
//
// Consequences that are intentional, not accidental:
//   - only `**bold**`, `*italic*`, `` `code` `` and `~~strike~~` are recognised;
//   - anything else (links, nested emphasis, HTML, malformed delimiters) is
//     rendered as literal text, which is what an activity label should do;
//   - because nothing is deferred, an activity row never first paints
//     unformatted text.

import { memo, type ReactNode } from 'react'

export interface InlineMarkdownProps {
  text: string
}

/** Longest-first so `**` wins over `*` and no delimiter can half-match. */
const INLINE_TOKEN_PATTERN = /(`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\*[^*\n]+\*)/gu

export const InlineMarkdown = memo(function InlineMarkdown({ text }: InlineMarkdownProps) {
  return <span className="markdown markdown-inline">{renderInline(text)}</span>
})

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0
  let key = 0
  for (const match of text.matchAll(INLINE_TOKEN_PATTERN)) {
    const start = match.index
    if (start > cursor) nodes.push(text.slice(cursor, start))
    const token = match[0]
    if (token.startsWith('`')) {
      nodes.push(<code className="markdown-inline-code" key={key++}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('~~')) {
      nodes.push(<del key={key++}>{token.slice(2, -2)}</del>)
    } else {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>)
    }
    cursor = start + token.length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}
