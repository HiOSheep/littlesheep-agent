import { useEffect, useState } from 'react'
import { ExternalOpenIcon, RefreshIcon } from '../ui/icons'

export function WorkspaceBrowser({
  url,
  onNavigate,
  onOpenExternal,
}: {
  url: string
  onNavigate: (url: string) => void
  onOpenExternal: (url: string) => void
}) {
  const [draft, setDraft] = useState(url)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => setDraft(url), [url])

  function navigate() {
    const next = normalizeBrowserInput(draft)
    if (next) onNavigate(next)
  }

  return (
    <section className="workspace-browser">
      <form
        className="workspace-browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          navigate()
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="网页地址"
          placeholder="输入 https:// 地址"
          spellCheck={false}
        />
        <button type="button" aria-label="刷新网页" disabled={!url} onClick={() => setReloadKey((key) => key + 1)}>
          <RefreshIcon />
        </button>
        <button type="button" aria-label="使用系统浏览器打开" disabled={!url} onClick={() => onOpenExternal(url)}>
          <ExternalOpenIcon />
        </button>
      </form>
      <div className="workspace-browser-body">
        {url ? (
          <iframe
            key={`${url}:${reloadKey}`}
            src={url}
            title={url}
            referrerPolicy="no-referrer"
            sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
          />
        ) : (
          <div className="workspace-browser-empty">从对话中的链接进入网页预览。</div>
        )}
      </div>
    </section>
  )
}

function normalizeBrowserInput(value: string): string {
  const input = value.trim()
  if (!input) return ''
  if (/^https?:\/\//iu.test(input)) return input
  return `https://${input}`
}
