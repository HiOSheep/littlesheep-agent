import { useEffect, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'

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

const components: Components = {
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
