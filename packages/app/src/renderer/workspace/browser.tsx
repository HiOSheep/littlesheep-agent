// 内置浏览器标签、导航历史、加载状态和网页内跳转的 Renderer 视图。
import { createElement, useEffect, useRef, useState } from 'react'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { BrowserBackIcon, BrowserForwardIcon, RefreshIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import {
  normalizeBrowserEventUrl,
  normalizeBrowserUrl,
  type WorkspaceBrowserHistory,
} from './browser-history'
import { canStartBrowserNavigation } from './browser-navigation'

type BrowserViewElement = HTMLElement & {
  loadURL?: (url: string) => Promise<void>
  reload?: () => void
}

type BrowserNavigationMode = 'push' | 'replace'

type PendingNavigationKind = 'load' | 'already-loaded' | 'reload'

interface PendingNavigation {
  url: string
  kind: PendingNavigationKind
  sequence: number
  started: boolean
}

export function WorkspaceBrowser({
  url,
  history,
  onNavigate,
  onHistoryMove,
  onTipChange,
}: {
  url: string
  history: WorkspaceBrowserHistory
  onNavigate: (url: string, mode?: BrowserNavigationMode) => void
  onHistoryMove: (delta: number) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [draft, setDraft] = useState(url)
  const [loading, setLoading] = useState(false)
  const browserRef = useRef<BrowserViewElement | null>(null)
  const browserReadyRef = useRef(false)
  const currentUrlRef = useRef('')
  const browserHistoryRef = useRef(history)
  const onNavigateRef = useRef(onNavigate)
  const pendingNavigationRef = useRef<PendingNavigation | null>(null)
  const navigationSequenceRef = useRef(0)

  // Keep the logical cursor current even when two toolbar clicks arrive
  // before React has committed the parent's state update.
  browserHistoryRef.current = history

  useEffect(() => {
    onNavigateRef.current = onNavigate
  }, [onNavigate])

  useEffect(() => {
    const browser = browserRef.current
    if (!browser) return

    const markBrowserReady = () => {
      if (browserReadyRef.current) return
      browserReadyRef.current = true
      const pending = pendingNavigationRef.current
      if (pending) startPendingNavigation(pending.sequence)
    }

    const readEventUrl = (event: Event): string => {
      const nextUrl = (event as Event & { url?: string }).url
      return typeof nextUrl === 'string' ? normalizeBrowserEventUrl(nextUrl) : ''
    }
    const observeNavigation = (event: Event) => {
      const nextUrl = readEventUrl(event)
      if (!nextUrl) return
      setDraft(nextUrl)
      setLoading(false)
      const pending = pendingNavigationRef.current
      if (pending?.kind === 'load' || pending?.kind === 'reload') {
        if (pending.url !== nextUrl) {
          // A redirect changes the current entry, but it is still the same
          // navigation. Mark it as already loaded before updating React state
          // so the URL effect does not load the redirected page a second time.
          pendingNavigationRef.current = {
            url: nextUrl,
            kind: 'already-loaded',
            sequence: pending.sequence,
            started: true,
          }
          onNavigateRef.current(nextUrl, 'replace')
        } else {
          pendingNavigationRef.current = null
        }
        return
      }
      if (pending?.kind === 'already-loaded') pendingNavigationRef.current = null
      if (nextUrl === currentUrlRef.current) return
      beginPendingNavigation(nextUrl, 'already-loaded')
      onNavigateRef.current(nextUrl, 'push')
    }
    const routePopupInside = (event: Event) => {
      event.preventDefault()
      const nextUrl = readEventUrl(event)
      if (!nextUrl) return
      requestNavigation(nextUrl)
    }
    const startLoading = () => setLoading(true)
    const stopLoading = () => {
      setLoading(false)
      const pending = pendingNavigationRef.current
      if (pending?.started && (pending.kind === 'load' || pending.kind === 'reload')) {
        pendingNavigationRef.current = null
      }
    }
    const failLoading = (_event: Event) => {
      // Chromium reports -3 for an interrupted load as well. It still means
      // this request is no longer loading from the user's perspective; leave
      // the next request to establish its own pending state.
      if (pendingNavigationRef.current && !pendingNavigationRef.current.started) return
      pendingNavigationRef.current = null
      setLoading(false)
    }

    browser.addEventListener('dom-ready', markBrowserReady)
    browser.addEventListener('did-navigate', observeNavigation)
    browser.addEventListener('did-navigate-in-page', observeNavigation)
    browser.addEventListener('new-window', routePopupInside)
    browser.addEventListener('did-start-loading', startLoading)
    browser.addEventListener('did-stop-loading', stopLoading)
    browser.addEventListener('did-fail-load', failLoading)
    return () => {
      browser.removeEventListener('dom-ready', markBrowserReady)
      browser.removeEventListener('did-navigate', observeNavigation)
      browser.removeEventListener('did-navigate-in-page', observeNavigation)
      browser.removeEventListener('new-window', routePopupInside)
      browser.removeEventListener('did-start-loading', startLoading)
      browser.removeEventListener('did-stop-loading', stopLoading)
      browser.removeEventListener('did-fail-load', failLoading)
    }
  // Rebind when the active URL changes because the popup handler closes over
  // the current reload target. Keeping only the truthiness dependency would
  // leave it pointing at the first page after in-browser navigation.
  }, [url])

  useEffect(() => {
    const previousUrl = currentUrlRef.current
    currentUrlRef.current = url
    setDraft(url)
    if (!url || url === previousUrl) return

    const pending = pendingNavigationRef.current
    if (pending?.url === url && pending.kind === 'already-loaded') {
      pendingNavigationRef.current = null
      return
    }
    if (pending?.url !== url) pendingNavigationRef.current = null

    const sequence = beginPendingNavigation(url, 'load')
    startPendingNavigation(sequence)
  }, [url])

  useEffect(() => () => {
    browserReadyRef.current = false
    pendingNavigationRef.current = null
    navigationSequenceRef.current += 1
  }, [])

  function beginPendingNavigation(url: string, kind: PendingNavigationKind): number {
    const sequence = navigationSequenceRef.current + 1
    navigationSequenceRef.current = sequence
    pendingNavigationRef.current = { url, kind, sequence, started: false }
    return sequence
  }

  function startPendingNavigation(sequence: number) {
    const pending = pendingNavigationRef.current
    const browser = browserRef.current
    // Electron does expose `loadURL` on the element before its guest has
    // finished attaching, but invoking it in that window can reject and leave
    // the first real URL stranded behind the initial about:blank page. The
    // dom-ready handler above is the single readiness boundary for all loads.
    if (!canStartBrowserNavigation(
      pending,
      sequence,
      browserReadyRef.current,
      Boolean(browser),
    )) return
    if (!pending || !browser) return

    const load = pending.kind === 'reload' && browser.reload
      ? () => browser.reload?.()
      : browser.loadURL
        ? () => browser.loadURL?.(pending.url)
        : null
    if (!load) return

    pending.started = true
    setLoading(true)
    try {
      const result = load()
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch(() => {
          if (pendingNavigationRef.current?.sequence !== sequence) return
          pendingNavigationRef.current = null
          setLoading(false)
        })
      }
    } catch {
      if (pendingNavigationRef.current?.sequence !== sequence) return
      pendingNavigationRef.current = null
      setLoading(false)
    }
  }

  function requestNavigation(nextUrl: string) {
    const normalized = normalizeBrowserUrl(nextUrl)
    if (!normalized) return
    if (normalized === currentUrlRef.current) {
      reload()
      return
    }
    beginPendingNavigation(normalized, 'load')
    onNavigateRef.current(normalized, 'push')
  }

  function moveHistory(delta: number) {
    const step = Math.trunc(delta)
    if (step === 0) return
    const currentHistory = browserHistoryRef.current
    const targetIndex = currentHistory.index + step
    const targetUrl = currentHistory.entries[targetIndex]
    if (!targetUrl) return
    // The logical stack is the source of truth. A webview may be recreated
    // when the workspace tab is switched, so its Chromium history is not
    // guaranteed to line up with this bounded LS history.
    beginPendingNavigation(targetUrl, 'load')
    browserHistoryRef.current = {
      entries: currentHistory.entries,
      index: targetIndex,
    }
    onHistoryMove(step)
  }

  function reload() {
    const browser = browserRef.current
    if (!browser || !url) return
    const sequence = beginPendingNavigation(url, 'reload')
    startPendingNavigation(sequence)
  }

  return (
    <section className="workspace-browser" aria-busy={loading}>
      <div className="workspace-browser-toolbar">
        <div className="workspace-browser-nav" aria-label="网页导航">
          <button
            {...transientTriggerProps()}
            type="button"
            aria-label="返回上一个网页"
            disabled={history.index <= 0}
            onClick={() => moveHistory(-1)}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('返回上一个网页', event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip('返回上一个网页', event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('返回上一个网页', event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            <BrowserBackIcon />
          </button>
          <button
            {...transientTriggerProps()}
            type="button"
            aria-label="前往下一个网页"
            disabled={history.index < 0 || history.index >= history.entries.length - 1}
            onClick={() => moveHistory(1)}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('前往下一个网页', event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip('前往下一个网页', event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('前往下一个网页', event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            <BrowserForwardIcon />
          </button>
          <button
            {...transientTriggerProps()}
            type="button"
            className={loading ? 'is-loading' : undefined}
            aria-label="刷新网页"
            disabled={!url}
            onClick={reload}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('刷新网页', event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip('刷新网页', event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('刷新网页', event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            <RefreshIcon />
          </button>
        </div>
        <form
          className="workspace-browser-address"
          onSubmit={(event) => {
            event.preventDefault()
            requestNavigation(draft)
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="网页地址"
            placeholder="输入 https:// 地址"
            spellCheck={false}
          />
        </form>
      </div>
      <div className="workspace-browser-body">
        {url ? (
          createElement('webview', {
            ref: (node: HTMLElement | null): void => { browserRef.current = node as BrowserViewElement | null },
            src: 'about:blank',
            title: url,
            partition: 'persist:littlesheep-browser',
            allowpopups: false,
            webpreferences: 'contextIsolation=yes,sandbox=yes,backgroundThrottling=yes',
          })
        ) : (
          <div className="workspace-browser-empty">从对话中的链接进入网页预览。</div>
        )}
      </div>
    </section>
  )
}
