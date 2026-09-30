// Markdown rendering, safe links, streaming partitions, code blocks, and Mermaid diagrams for chat and previews.
import { lazy, memo, Suspense, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useLinkNavigation } from './link-navigation'
import { StreamingMarkdownPartitioner } from './streaming-markdown'
import { CheckIcon, CopyIcon } from './ui/icons'
import { CodeWrapToggle } from './ui/code-wrap-toggle'
import { useCodeWrapPreference } from './ui/code-wrap-preference'
import { APPEARANCE_PREFERENCES_EVENT, isAppearanceDark } from './app-shell/appearance-preferences'

// Single-line activity labels are rendered by a bounded scanner instead of the
// parser below, so an activity row never depends on the Markdown plugin chain.
export { InlineMarkdown, type InlineMarkdownProps } from './inline-markdown'

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
let mermaidRenderQueue: Promise<void> = Promise.resolve()

function isMermaidCodeBlock(language: string | undefined, code: string): boolean {
  const normalizedLanguage = language?.trim().toLowerCase()
  if (normalizedLanguage) return MERMAID_LANGUAGE_ALIASES.has(normalizedLanguage)
  return MERMAID_DEFINITION_PATTERN.test(code)
}

export function mermaidThemeVariables(isDark: boolean) {
  return isDark
    ? {
      background: 'transparent', primaryColor: '#2f2f2f', primaryTextColor: '#f4f4f4', primaryBorderColor: '#5a5a5a',
      lineColor: '#a8a8a8', secondaryColor: '#282828', tertiaryColor: '#202020', edgeLabelBackground: '#202020',
      clusterBkg: '#202020', clusterBorder: '#5a5a5a', textColor: '#f4f4f4',
    }
    : {
      background: 'transparent', primaryColor: '#ffffff', primaryTextColor: '#30302e', primaryBorderColor: '#b8b8b4',
      lineColor: '#5e5e5b', secondaryColor: '#f0f0ee', tertiaryColor: '#fafaf9', edgeLabelBackground: '#fafaf9',
      clusterBkg: '#f0f0ee', clusterBorder: '#b8b8b4', textColor: '#30302e',
    }
}

async function renderMermaid(id: string, definition: string, isDark: boolean): Promise<string> {
  const render = mermaidRenderQueue.then(async () => {
    mermaidModulePromise ??= import('mermaid')
    const { default: mermaid } = await mermaidModulePromise
    const theme = mermaidThemeVariables(isDark)
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: {
        ...theme,
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
          fill: ${theme.lineColor};
          stroke: ${theme.lineColor};
        }
        .label, .nodeLabel, .edgeLabel, text, tspan {
          color: ${theme.textColor};
          fill: ${theme.textColor};
        }
      `,
    })
    await mermaid.parse(definition)
    const result = await mermaid.render(id, definition)
    return result.svg
  })
  mermaidRenderQueue = render.then(() => undefined, () => undefined)
  return render
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
function CodeToolbar({
  code,
  language,
  wrapped,
  onToggleWrap,
}: {
  code: string
  language: string
  wrapped: boolean
  onToggleWrap: () => void
}) {
  return (
    <div className="code-toolbar">
      <span className="code-language-label">{(language || 'text').toUpperCase()}</span>
      <div className="code-toolbar-actions">
        <CodeWrapToggle wrapped={wrapped} onToggle={onToggleWrap} />
        <CopyButton text={code} label="代码" />
      </div>
    </div>
  )
}

/**
 * The wrap choice as box properties, applied to the scrolling element and to the
 * code element inside it so `data-code-wrap` and the inline style cannot disagree.
 */
function codeWrapStyle(wrapped: boolean) {
  return wrapped
    ? { whiteSpace: 'pre-wrap' as const, overflowWrap: 'anywhere' as const, wordBreak: 'break-word' as const }
    : { whiteSpace: 'pre' as const, overflowWrap: 'normal' as const, wordBreak: 'normal' as const }
}

/**
 * The box the lazy highlighter gives a code block, taken from the style object the
 * highlighter itself is configured with (`syntaxTheme`'s `code[class*="language-"]`
 * metrics and colors, which Prism applies to the element it renders).
 *
 * Measured on the built renderer before this was shared: the plain fallback `<pre>`
 * inherited the message's line height and `.markdown pre`'s bottom margin while the
 * highlighted block carried Prism's metrics and no margin, so the swap moved every
 * block below the code by 6.38px. Rendering both states into this one box is what
 * makes the swap a no-op for the reader's position.
 */
function codeSourceStyle(wrapped: boolean, syntaxTheme: typeof oneDark = oneDark) {
  const prism = syntaxTheme['code[class*="language-"]'] ?? {}
  const wrap = codeWrapStyle(wrapped)
  return {
    source: {
      ...prism,
      margin: 0,
      maxWidth: '100%',
      overflowX: wrapped ? ('hidden' as const) : ('auto' as const),
      overflowY: 'hidden' as const,
      background: 'transparent',
      backgroundColor: 'transparent',
      padding: 'var(--code-block-inset)',
      ...wrap,
    },
    code: { background: 'transparent', ...wrap },
  }
}

function PlainCodeFallback({
  code,
  language,
  wrapped,
  syntaxTheme,
  onToggleWrap,
}: {
  code: string
  language: string
  wrapped: boolean
  syntaxTheme: typeof oneDark
  onToggleWrap: () => void
}) {
  const source = codeSourceStyle(wrapped, syntaxTheme)
  return (
    <div className="code-block">
      <CodeToolbar code={code} language={language} wrapped={wrapped} onToggleWrap={onToggleWrap} />
      {/* An element, not a `<pre>`: the highlighted state is a `div` (the highlighter's
          `PreTag`), and only the same tag keeps `pre`-scoped rules from changing the box. */}
      <div className="code-block-source" data-code-wrap={wrapped ? 'on' : 'off'} style={source.source}>
        <code className={`language-${language}`} style={source.code}>{code}</code>
      </div>
    </div>
  )
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [wrapped, setWrapped] = useCodeWrapPreference()
  const syntaxTheme = useSyntaxTheme()
  const source = codeSourceStyle(wrapped, syntaxTheme)
  return (
    <Suspense fallback={(
      <PlainCodeFallback
        code={code}
        language={language}
        wrapped={wrapped}
        syntaxTheme={syntaxTheme}
        onToggleWrap={() => setWrapped(!wrapped)}
      />
    )}>
      <div className="code-block">
        <CodeToolbar
          code={code}
          language={language}
          wrapped={wrapped}
          onToggleWrap={() => setWrapped(!wrapped)}
        />
        <SyntaxHighlighter
          className="code-block-source"
          data-code-wrap={wrapped ? 'on' : 'off'}
          language={language}
          style={syntaxTheme}
          PreTag="div"
          wrapLongLines={wrapped}
          codeTagProps={{
            className: `language-${language}`,
            style: source.code,
          }}
          customStyle={source.source}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </Suspense>
  )
}

function useAppearanceDark(): boolean {
  const [dark, setDark] = useState(isAppearanceDark)
  useEffect(() => {
    const root = document.documentElement
    const update = () => setDark(isAppearanceDark())
    root.addEventListener(APPEARANCE_PREFERENCES_EVENT, update)
    return () => root.removeEventListener(APPEARANCE_PREFERENCES_EVENT, update)
  }, [])
  return dark
}

function useSyntaxTheme(): typeof oneDark {
  return useAppearanceDark() ? oneDark : oneLight
}

function MermaidBlock({ code }: { code: string }) {
  const isDark = useAppearanceDark()
  const reactId = useId()
  const renderId = `littlesheep-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/gu, '')}`
  const [svg, setSvg] = useState<string | null>(null)
  const [renderFailed, setRenderFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setRenderFailed(false)

    void renderMermaid(renderId, code, isDark)
      .then((nextSvg) => {
        if (!cancelled) setSvg(nextSvg)
      })
      .catch(() => {
        if (!cancelled) setRenderFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [code, isDark, renderId])

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
  // Copying used to await the clipboard write with nothing around it, so a rejected write became an unhandled
  // rejection, the success branch never ran, and the user saw no difference between "nothing happened" and "the
  // clipboard refused". Success is reported only after the write resolves, and a refusal says so and offers a retry -
  // the same shape the message action row already uses, so there is one copy contract rather than two.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copiedTimerRef = useRef<number>()

  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), [])

  async function copy() {
    window.clearTimeout(copiedTimerRef.current)
    try {
      await navigator.clipboard.writeText(text)
      setCopyState('copied')
      copiedTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1200)
    } catch {
      setCopyState('failed')
    }
  }

  const copied = copyState === 'copied'

  return (
    <>
      <button
        type="button"
        aria-label={copied ? `${label}已复制` : `复制${label}`}
        data-copied={copied ? 'true' : 'false'}
        data-copy-state={copyState}
        onClick={() => void copy()}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      {copyState === 'failed' && (
        // The note and its retry are siblings, the way `.message-copy-failed-row` renders them, so the
        // status line stays a status line and the retry stays a button. `failed` holds the toolbar open
        // for as long as it stands, so neither leaves with the pointer.
        <div className="code-copy-failed-row">
          <span className="code-copy-failed" role="status">复制失败</span>
          <button type="button" className="code-copy-retry" onClick={() => void copy()}>重试</button>
        </div>
      )}
    </>
  )
}
