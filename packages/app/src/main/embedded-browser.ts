// Electron adapter for the persistent embedded-browser session and webviews.
// Renderer state and Local App API contracts stay outside this host boundary.
import { session, shell } from 'electron'
import {
  BROWSER_OPEN_NEW_TAB_CHANNEL,
  EMBEDDED_BROWSER_PARTITION,
  type BrowserOpenNewTabEvent,
  type BrowserStorageOperationResult,
  type BrowserStorageStatus,
} from '../shared/browser-control-contracts.js'

let embeddedBrowserSession: Electron.Session | null = null
let embeddedBrowserOperation: Promise<void> | null = null

// Ordinary media, clipboard and storage are useful in an embedded browser;
// sensitive permissions remain denied until a dedicated policy exists.
const EMBEDDED_BROWSER_ALLOWED_PERMISSIONS = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'media',
  'mediaKeySystem',
  'pointerLock',
  'storage-access',
  'top-level-storage-access',
])

const EMBEDDED_BROWSER_TEXT_DOCUMENT_CSS = `
  html, body, pre {
    color: #202020 !important;
    background: #ffffff !important;
  }

  ::selection {
    color: #ffffff !important;
    background: #4f6fdc !important;
  }
`

function isRawTextDocumentUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return /^(?:raw|gist)\.githubusercontent\.com$/iu.test(parsed.hostname)
  } catch {
    return false
  }
}

async function applyTextDocumentContrast(guestContents: Electron.WebContents): Promise<void> {
  try {
    const pageUrl = guestContents.getURL()
    let isPlainText = isRawTextDocumentUrl(pageUrl)
    if (!isPlainText) {
      try {
        const contentType = await guestContents.executeJavaScript('document.contentType', true) as string | undefined
        isPlainText = contentType === 'text/plain'
      } catch {
        // Some sandboxed guests reject executeJavaScript. Keep the explicit
        // raw-text URL path independent from this optional detection.
      }
    }
    if (!isPlainText) return
    await guestContents.insertCSS(EMBEDDED_BROWSER_TEXT_DOCUMENT_CSS)
  } catch {
    // A guest can be destroyed between navigation and did-finish-load.
  }
}

function buildEmbeddedBrowserUserAgent(): string {
  const chrome = process.versions.chrome || '136.0.0.0'
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
}

export function getEmbeddedBrowserSession(): Electron.Session {
  if (embeddedBrowserSession) return embeddedBrowserSession
  const current = session.fromPartition(EMBEDDED_BROWSER_PARTITION)
  current.setPermissionCheckHandler((_webContents, permission) => {
    return EMBEDDED_BROWSER_ALLOWED_PERMISSIONS.has(permission)
  })
  current.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(EMBEDDED_BROWSER_ALLOWED_PERMISSIONS.has(permission))
  })
  embeddedBrowserSession = current
  return current
}

export function configureEmbeddedBrowserWindow(win: Electron.BrowserWindow): void {
  // HTTP(S) stays inside LS. Only explicitly external protocols leave the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:\/\//iu.test(url) && /^(mailto|tel):/iu.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('did-attach-webview', (_event, guestContents) => {
    guestContents.setUserAgent(buildEmbeddedBrowserUserAgent())
    guestContents.setWindowOpenHandler(({ url, disposition }) => {
      if (/^https?:\/\//iu.test(url)) {
        if (!guestContents.hostWebContents.isDestroyed()) {
          const payload: BrowserOpenNewTabEvent = { url, disposition }
          guestContents.hostWebContents.send(BROWSER_OPEN_NEW_TAB_CHANNEL, payload)
        }
      } else if (/^(mailto|tel):/iu.test(url)) {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })
    guestContents.on('did-finish-load', () => {
      void applyTextDocumentContrast(guestContents)
    })
    guestContents.on('will-navigate', (event, url) => {
      if (!/^https?:\/\//iu.test(url)) event.preventDefault()
    })
  })
}

export async function getBrowserStorageStatus(): Promise<BrowserStorageStatus> {
  const current = getEmbeddedBrowserSession()
  const cookies = await current.cookies.get({})
  const domains = new Set(cookies.map((cookie) => (cookie.domain ?? '').toLowerCase()).filter(Boolean))
  return {
    partition: EMBEDDED_BROWSER_PARTITION,
    persistent: true,
    cookieCount: cookies.length,
    cookieDomainCount: domains.size,
  }
}

async function runEmbeddedBrowserOperation(operation: () => Promise<void>): Promise<BrowserStorageOperationResult> {
  const previous = embeddedBrowserOperation
  const tracked = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(operation)
  embeddedBrowserOperation = tracked
  try {
    await tracked
    return {
      ok: true,
      clearedAt: new Date().toISOString(),
      status: await getBrowserStorageStatus(),
    }
  } finally {
    if (embeddedBrowserOperation === tracked) embeddedBrowserOperation = null
  }
}

export function clearEmbeddedBrowserCache(): Promise<BrowserStorageOperationResult> {
  return runEmbeddedBrowserOperation(async () => {
    const current = getEmbeddedBrowserSession()
    await Promise.all([current.clearCache(), current.clearHostResolverCache()])
  })
}

export function clearEmbeddedBrowserData(): Promise<BrowserStorageOperationResult> {
  return runEmbeddedBrowserOperation(async () => {
    const current = getEmbeddedBrowserSession()
    await Promise.all([
      current.clearData({
        dataTypes: [
          'backgroundFetch',
          'cache',
          'cookies',
          'fileSystems',
          'indexedDB',
          'localStorage',
          'serviceWorkers',
          'webSQL',
        ],
        originMatchingMode: 'third-parties-included',
      }),
      current.clearAuthCache(),
      current.clearHostResolverCache(),
    ])
  })
}
