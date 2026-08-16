import { memo, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useLinkNavigation } from './link-navigation'
import { StreamingMarkdownPartitioner } from './streaming-markdown'

interface MarkdownProps {
  text: string
  streaming?: boolean
}

export const Markdown = memo(function Markdown({ text, streaming = false }: MarkdownProps) {
  if (streaming) return <StreamingMarkdown text={text} />
  return (
    <div className="markdown">
      <MarkdownFragment source={text} />
    </div>
  )
})


function StreamingMarkdown({ text }: { text: string }) {
  const partitionerRef = useRef<StreamingMarkdownPartitioner>()
  partitionerRef.current ??= new StreamingMarkdownPartitioner()
  const partition = partitionerRef.current.update(text)
  return (
    <div className="markdown markdown-streaming">
      {partition.frozen.map((segment) => (
        <MarkdownFragment key={segment.key} source={segment.source} />
      ))}
      {partition.tail && <MarkdownFragment key="stream-tail" source={partition.tail} />}
    </div>
  )
}


const MarkdownFragment = memo(function MarkdownFragment({ source }: { source: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {source}
    </ReactMarkdown>
  )
})


/**
 * Markdown for a single activity row. Block elements are deliberately
 * unwrapped so the result remains valid phrasing content inside a button.
 */
export const InlineMarkdown = memo(function InlineMarkdown({ text }: MarkdownProps) {
  return (
    <span className="markdown markdown-inline">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        allowedElements={['p', 'strong', 'em', 'del', 'code', 'a', 'br']}
        unwrapDisallowed
        components={inlineComponents}
      >
        {text}
      </ReactMarkdown>
    </span>
  )
})

const components: Components = {
  a({ href, children }) {
    return <MarkdownLink href={href}>{children}</MarkdownLink>
  },
  code({ className, children, ...props }) {
    const rawCode = String(children)
    const code = rawCode.replace(/\n$/, '')
    const language = /language-(\w+)/.exec(className ?? '')?.[1]
    if (!language && !rawCode.endsWith('\n')) {
      return (
        <code className="markdown-inline-code" {...props}>
          {children}
        </code>
      )
    }
    return <CodeBlock code={code} language={language ?? 'text'} />
  },
}

const inlineComponents: Components = {
  p({ children }) {
    return <>{children}</>
  },
  a({ children }) {
    // Activity summaries are labels, not navigation targets. Keeping links
    // as spans also avoids nested interactive elements inside the row button.
    return <span className="markdown-inline-link">{children}</span>
  },
  br() {
    return <span aria-hidden="true"> </span>
  },
  code({ children }) {
    return <code className="markdown-inline-code">{children}</code>
  },
}

function MarkdownLink({ href, children }: { href?: string; children: ReactNode }) {
  const navigation = useLinkNavigation()
  const clickTimerRef = useRef<number>()

  useEffect(() => () => window.clearTimeout(clickTimerRef.current), [])

  function openInside(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault()
    if (!href) return
    window.clearTimeout(clickTimerRef.current)
    if (event.detail === 0) {
      navigation.openInside(href)
      return
    }
    if (event.detail > 1) return
    clickTimerRef.current = window.setTimeout(() => navigation.openInside(href), 230)
  }

  function openWithSystem(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault()
    if (!href) return
    window.clearTimeout(clickTimerRef.current)
    navigation.openWithSystem(href)
  }

  return (
    <a href={href} onClick={openInside} onDoubleClick={openWithSystem}>
      {children}
    </a>
  )
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number>()

  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), [])

  async function copy() {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    window.clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language}</span>
        <button type="button" onClick={() => void copy()}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        PreTag="div"
        customStyle={{ margin: 0, background: 'transparent', padding: '12px' }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}
