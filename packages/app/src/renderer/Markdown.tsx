// Markdown rendering, safe links, streaming partitions, code blocks, and Mermaid diagrams for chat and previews.
import { lazy, memo, Suspense, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useLinkNavigation } from './link-navigation'
import { StreamingMarkdownPartitioner } from './streaming-markdown'
import { CheckIcon, CopyIcon } from './ui/icons'

/**
 * Syntax highlighting is loaded on demand.
 *
 * Measured: importing the full Prism build costs ~380 ms in Node (300 language
 * modules plus 47 styles). Having it in the entry chunk spent that on every
 * cold start for chat surfaces that rarely show a code block at first paint, so
 * the highlighter moved to its own chunk and renders plain code until it
 * arrives. `Prism` (not `PrismLight`) is kept so any language still highlights
 * once the chunk is present.
 */
const SyntaxHighlighter = lazy(async () => ({
  default: (await import('react-syntax-highlighter')).Prism,
}))

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

const MERMAID_LANGUAGE_ALIASES = new Set([
  'mermaid',
  'mmd',
  'flowchart',
  'graph',
  'statediagram',
  'statediagram-v2',
  'sequencediagram',
  'classdiagram',
  'classdiagram-v2',
  'erdiagram',
  'journey',
  'gantt',
  'pie',
  'mindmap',
  'timeline',
  'gitgraph',
  'quadrantchart',
  'requirementdiagram',
  'c4context',
  'packet-beta',
  'block-beta',
  'architecture-beta',
])

const MERMAID_DEFINITION_PATTERN = /^\s*(?:stateDiagram(?:-v2)?|flowchart|graph|sequenceDiagram|classDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|c4Context|packet-beta|block-beta|architecture-beta)\b/iu

let mermaidModulePromise: Promise<typeof import('mermaid')> | undefined
let mermaidConfigured = false

function isMermaidCodeBlock(language: string | undefined, code: string): boolean {
  const normalizedLanguage = language?.trim().toLowerCase()
  if (normalizedLanguage) return MERMAID_LANGUAGE_ALIASES.has(normalizedLanguage)
  return MERMAID_DEFINITION_PATTERN.test(code)
}

async function renderMermaid(id: string, definition: string): Promise<string> {
  mermaidModulePromise ??= import('mermaid')
  const { default: mermaid } = await mermaidModulePromise

  if (!mermaidConfigured) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: {
        background: 'transparent',
        primaryColor: '#2f2f2f',
        primaryTextColor: '#f4f4f4',
        primaryBorderColor: '#5a5a5a',
        lineColor: '#a8a8a8',
        secondaryColor: '#282828',
        tertiaryColor: '#202020',
        edgeLabelBackground: '#202020',
        clusterBkg: '#202020',
        clusterBorder: '#5a5a5a',
        textColor: '#f4f4f4',
        fontFamily: 'Arial, "Microsoft YaHei", sans-serif',
        fontSize: '14px',
      },
      themeCSS: `
        .node rect, .node circle, .node ellipse, .node polygon,
        .stateGroup rect, .stateGroup circle, .stateGroup ellipse {
          rx: 7px;
          ry: 7px;
          stroke-width: 1px;
        }
        .edgePath .path, .flowchart-link, .transition {
          stroke-width: 1.2px;
        }
        .marker, .arrowheadPath {
          fill: #a8a8a8;
          stroke: #a8a8a8;
        }
        .label, .nodeLabel, .edgeLabel, text, tspan {
          color: #f4f4f4;
          fill: #f4f4f4;
        }
      `,
    })
    mermaidConfigured = true
  }

  await mermaid.parse(definition)
  const result = await mermaid.render(id, definition)
  return result.svg
}

const components: Components = {
  a({ href, children }) {
    return <MarkdownLink href={href}>{children}</MarkdownLink>
  },
  table({ children }) {
    return (
      <div className="markdown-table-wrap">
        <table>{children}</table>
      </div>
    )
  },
  code({ className, children, ...props }) {
    const rawCode = String(children)
    const code = rawCode.replace(/\n$/, '')
    const language = /language-([\w-]+)/u.exec(className ?? '')?.[1]?.toLowerCase()
    if (!language && !rawCode.endsWith('\n')) {
      return (
        <code className="markdown-inline-code" {...props}>
          {children}
        </code>
      )
    }
    if (isMermaidCodeBlock(language, code)) {
      return <MermaidBlock code={code} />
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

/**
 * Plain, layout-stable fallback for the moments before the highlighter chunk
 * arrives. It reuses the highlighter's own class names and inline styles so the
 * swap does not move the surrounding layout.
 */
function PlainCodeFallback({ code, language }: { code: string; language: string }) {
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <CopyButton text={code} label="代码" />
      </div>
      <pre
        className="code-block-source"
        style={{
          margin: 0,
          maxWidth: '100%',
          overflow: 'hidden',
          overflowWrap: 'anywhere',
          background: 'transparent',
          backgroundColor: 'transparent',
          padding: 'var(--code-block-inset)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          paddingRight: 'calc(var(--code-block-inset) + var(--code-copy-button-size) + var(--code-copy-safe-gap))',
        }}
      >
        <code className={`language-${language}`} style={{ background: 'transparent' }}>{code}</code>
      </pre>
    </div>
  )
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  return (
    <Suspense fallback={<PlainCodeFallback code={code} language={language} />}>
      <div className="code-block">
        <div className="code-toolbar">
          <CopyButton text={code} label="代码" />
        </div>
        <SyntaxHighlighter
          className="code-block-source"
          language={language}
          style={oneDark}
          PreTag="div"
          wrapLongLines
          codeTagProps={{
            className: `language-${language}`,
            style: {
              background: 'transparent',
              backgroundColor: 'transparent',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              wordBreak: 'break-word',
            },
          }}
          customStyle={{
            margin: 0,
            maxWidth: '100%',
            overflow: 'hidden',
            overflowWrap: 'anywhere',
            background: 'transparent',
            backgroundColor: 'transparent',
            padding: 'var(--code-block-inset)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            paddingRight: 'calc(var(--code-block-inset) + var(--code-copy-button-size) + var(--code-copy-safe-gap))',
          }}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </Suspense>
  )
}

function MermaidBlock({ code }: { code: string }) {
  const reactId = useId()
  const renderId = `littlesheep-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/gu, '')}`
  const [svg, setSvg] = useState<string | null>(null)
  const [renderFailed, setRenderFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setRenderFailed(false)

    void renderMermaid(renderId, code)
      .then((nextSvg) => {
        if (!cancelled) setSvg(nextSvg)
      })
      .catch(() => {
        if (!cancelled) setRenderFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [code, renderId])

  if (renderFailed || !svg) return <CodeBlock code={code} language="text" />

  return (
    <div className="code-block mermaid-block">
      <div className="code-toolbar">
        <CopyButton text={code} label="图表代码" />
      </div>
      <div
        className="mermaid-block-surface"
        role="img"
        aria-label="Mermaid 图表"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  )
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number>()

  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), [])

  async function copy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <button
      type="button"
      aria-label={copied ? `${label}已复制` : `复制${label}`}
      data-copied={copied ? 'true' : 'false'}
      onClick={() => void copy()}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}
