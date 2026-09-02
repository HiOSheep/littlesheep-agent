// 内置浏览器标签、导航历史、加载状态和网页内跳转的 Renderer 视图。
import { createElement, useEffect, useRef, useState } from 'react'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { RefreshIcon } from '../ui/icons'
import { HistoryBackIcon, HistoryForwardIcon, BrowserNewTabIcon } from '../ui/browser-icons'
import { transientTriggerProps } from '../ui/transient'
import { EMBEDDED_BROWSER_PARTITION } from '../../shared/browser-control-contracts'
import { normalizeBrowserEventUrl, normalizeBrowserUrl, type WorkspaceBrowserHistory } from './browser-history'
import type { WorkspaceBrowserTabId } from './browser-tabs'
import { canStartBrowserNavigation } from './browser-navigation'

type BrowserViewElement = HTMLElement & {
  loadURL?: (url: string) => Promise<void>
  reload?: () => void
  getTitle?: () => Promise<string>
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
  tabId,
  url,
  history,
  active = true,
  onNavigate,
  onHistoryMove,
  onOpenNewTab,
  onTitleChange,
  onTipChange,
}: {
  tabId: WorkspaceBrowserTabId
  url: string
  history: WorkspaceBrowserHistory
  active?: boolean
  onNavigate: (url: string, mode?: BrowserNavigationMode) => void
  onHistoryMove: (delta: number) => void
  onOpenNewTab: (url: string) => void
  onTitleChange: (title: string) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [draft, setDraft] = useState(url)
  const [loading, setLoading] = useState(false)
  const browserRef = useRef<BrowserViewElement | null>(null)
  const browserReadyRef = useRef(false)
  const currentUrlRef = useRef('')
  const browserHistoryRef = useRef(history)
  const onNavigateRef = useRef(onNavigate)
  const onOpenNewTabRef = useRef(onOpenNewTab)
  const onTitleChangeRef = useRef(onTitleChange)
  const pendingNavigationRef = useRef<PendingNavigation | null>(null)
  const navigationSequenceRef = useRef(0)
  const lastPopupRef = useRef<{ url: string; at: number } | null>(null)

  // Keep the logical cursor current even when two toolbar clicks arrive
  // before React has committed the parent's state update.
  browserHistoryRef.current = history

  useEffect(() => {
    onNavigateRef.current = onNavigate
  }, [onNavigate])

  useEffect(() => {
    onOpenNewTabRef.current = onOpenNewTab
  }, [onOpenNewTab])

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange
  }, [onTitleChange])

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
      const navigationEvent = event as Event & { url?: string; isMainFrame?: boolean }
      if (navigationEvent.isMainFrame === false) return ''
      const nextUrl = navigationEvent.url
      return typeof nextUrl === 'string' ? normalizeBrowserEventUrl(nextUrl) : ''
    }
    const observeNavigation = (event: Event) => {
      if (!active) return
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
      if (!active) return
      event.preventDefault()
      const nextUrl = readEventUrl(event)
      if (!nextUrl) return
      routeNewTab(nextUrl)
    }
    const observeTitle = (event: Event) => {
      if (!active) return
      const title = (event as Event & { title?: string }).title
      if (typeof title === 'string' && title.trim()) onTitleChangeRef.current(title)
    }
    const observeFinishedLoad = () => {
      const getTitle = browser.getTitle
      if (!getTitle) return
      void getTitle().then((title) => {
        if (title.trim()) onTitleChangeRef.current(title)
      }).catch(() => undefined)
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
    browser.addEventListener('page-title-updated', observeTitle)
    browser.addEventListener('did-finish-load', observeFinishedLoad)
    browser.addEventListener('did-start-loading', startLoading)
    browser.addEventListener('did-stop-loading', stopLoading)
    browser.addEventListener('did-fail-load', failLoading)
    const unsubscribe = active
      ? window.littlesheep?.onBrowserOpenNewTab?.(({ url: nextUrl }) => routeNewTab(nextUrl))
      : undefined
    return () => {
      browser.removeEventListener('dom-ready', markBrowserReady)
      browser.removeEventListener('did-navigate', observeNavigation)
      browser.removeEventListener('did-navigate-in-page', observeNavigation)
      browser.removeEventListener('new-window', routePopupInside)
      browser.removeEventListener('page-title-updated', observeTitle)
      browser.removeEventListener('did-finish-load', observeFinishedLoad)
      browser.removeEventListener('did-start-loading', startLoading)
      browser.removeEventListener('did-stop-loading', stopLoading)
      browser.removeEventListener('did-fail-load', failLoading)
      unsubscribe?.()
    }
  // Rebind when the active URL changes because the popup handler closes over
  // the current reload target. Keeping only the truthiness dependency would
  // leave it pointing at the first page after in-browser navigation.
  }, [active, url])

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

  function routeNewTab(nextUrl: string) {
    const normalized = normalizeBrowserUrl(nextUrl)
    if (!normalized) return
    const now = Date.now()
    const previous = lastPopupRef.current
    if (previous && previous.url === normalized && now - previous.at < 400) return
    lastPopupRef.current = { url: normalized, at: now }
    onOpenNewTabRef.current(normalized)
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
      <div className="workspace-browser-toolbar workspace-page-leading-row">
        <div className="workspace-browser-nav" aria-label="网页导航">
          <button
            {...transientTriggerProps()}
            className="history-nav-btn"
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
            <HistoryBackIcon />
          </button>
          <button
            {...transientTriggerProps()}
            className="history-nav-btn"
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
            <HistoryForwardIcon />
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
          <button
            {...transientTriggerProps()}
            type="button"
            aria-label="新建浏览器标签"
            onClick={() => onOpenNewTabRef.current('')}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('新建浏览器标签', event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip('新建浏览器标签', event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('新建浏览器标签', event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            <BrowserNewTabIcon />
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
            key: tabId,
            ref: (node: HTMLElement | null): void => {
              if (node) {
                // React does not reliably serialize Electron's custom
                // `allowpopups` boolean property. Set both forms before the
                // guest performs its first real navigation.
                node.setAttribute('allowpopups', '')
                const browserNode = node as BrowserViewElement & { allowpopups?: boolean }
                browserNode.allowpopups = true
              }
              browserRef.current = node as BrowserViewElement | null
            },
            src: 'about:blank',
            title: url,
            partition: EMBEDDED_BROWSER_PARTITION,
            // Let Chromium create the window request. The main process
            // intercepts it and routes the URL back into an LS browser tab;
            // keeping this enabled is required for target="_blank" links and
            // window.open() to reach that routing boundary.
            // Use a string attribute here. React treats an unknown custom
            // element boolean prop as a property and may omit it during the
            // element's initial upgrade; Electron reads allowpopups only at
            // guest creation time.
            allowpopups: '',
            webpreferences: 'contextIsolation=yes,sandbox=yes,nativeWindowOpen=yes,backgroundThrottling=yes,autoplayPolicy=no-user-gesture-required',
          })
        ) : (
          <div className="workspace-browser-empty">从对话中的链接进入网页预览。</div>
        )}
      </div>
    </section>
  )
}
