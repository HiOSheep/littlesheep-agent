import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useLinkNavigation } from './link-navigation'

interface MarkdownProps {
  text: string
}

export function Markdown({ text }: MarkdownProps) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}


/**
 * Markdown for a single activity row. Block elements are deliberately
 * unwrapped so the result remains valid phrasing content inside a button.
 */
export function InlineMarkdown({ text }: MarkdownProps) {
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
}

const components: Components = {
  a({ href, children }) {
    return <MarkdownLink href={href}>{children}</MarkdownLink>
  },
  code({ className, children, ...props }) {
    const code = String(children).replace(/\n$/, '')
    const language = /language-(\w+)/.exec(className ?? '')?.[1]
    if (!language) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    }
    return <CodeBlock code={code} language={language} />
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
    return <code>{children}</code>
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
