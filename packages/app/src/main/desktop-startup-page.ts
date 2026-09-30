// Standalone first-frame document for the desktop window.
//
// The window appears before the Runtime starts, so this page must not depend on
// the renderer bundle, the Local App API, or the Vite development server. It is
// intentionally icon-only: no progress claim may be shown before a real fact
// exists.
//
// Surface contract (CS-02): this page, `BrowserWindow.titleBarOverlay` and the
// renderer's `.window-titlebar` all paint the same opaque `#101010`. A
// translucent overlay over the native caption buttons produced the visible seam
// in the cold-start screenshots, so no material is layered here.

/** Opaque application surface shared by the startup page and the native overlay. */
export const DESKTOP_STARTUP_SURFACE = '#101010'
/** Kept for callers that only need the window's initial background color. */
export const DESKTOP_STARTUP_WINDOW_BACKGROUND = DESKTOP_STARTUP_SURFACE
/** Must stay equal to `WINDOW_TITLEBAR_HEIGHT` in `./desktop-shell.js`. */
export const DESKTOP_TITLEBAR_HEIGHT = 32

const STARTUP_ICON_SIZE_PX = 112

export interface DesktopStartupPageOptions {
  errorMessage?: string
  /**
   * Whether Main's bounded retry can be offered for this failure.
   *
   * The failure page is the last surface a pre-renderer failure has, so a startup
   * that failed before the React notice ever mounted must still be able to ask for
   * the same retry that notice offers. Main owns the bound and the single-flight
   * rule; the page only forwards the click and states what came back.
   */
  retryable?: boolean
}

/**
 * Build a standalone document so the first visible frame has no dependency on
 * the renderer bundle, the local API, or the Vite development server.
 */
export function createDesktopStartupPageHtml(
  iconDataUrl?: string,
  options: DesktopStartupPageOptions = {},
): string {
  const icon = isPngDataUrl(iconDataUrl)
    ? `<img class="startup-icon" src="${iconDataUrl}" alt="LittleSheep" />`
    : ''
  const errorMessage = options.errorMessage?.trim()
  // The retry control only exists where Main said a retry is possible. Its label
  // is the same sentence the React notice uses (`execution-retry-state.ts`), so
  // the two failure surfaces name one action the same way.
  const retryControl = errorMessage && options.retryable === true
    ? `<button class="startup-retry" type="button">重试启动运行能力</button><p class="startup-retry-note" role="status" aria-live="polite"></p>`
    : ''
  const error = errorMessage
    ? `<section class="startup-error" role="alert"><strong>LittleSheep 无法启动</strong><p>${escapeHtml(errorMessage.slice(0, 1000))}</p>${retryControl}</section>`
    : ''

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <title>LittleSheep</title>
    <style>
      :root {
        color-scheme: light dark;
        background: ${DESKTOP_STARTUP_SURFACE};
      }

      * { box-sizing: border-box; }

      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
      }

      @media (prefers-color-scheme: light) {
        :root, body { background: #f4f4f2; }
        .startup-error { color: rgba(20, 20, 20, 0.88); background: rgba(255, 255, 255, 0.72); }
        .startup-error p, .startup-retry-note { color: rgba(20, 20, 20, 0.66); }
        .startup-retry:hover:not(:disabled) { background: rgba(0, 0, 0, 0.06); }
      }

      body {
        background: ${DESKTOP_STARTUP_SURFACE};
      }

      .startup-drag-region {
        position: fixed;
        top: 0;
        right: 150px;
        left: 0;
        z-index: 1;
        height: ${DESKTOP_TITLEBAR_HEIGHT}px;
        -webkit-app-region: drag;
        user-select: none;
      }

      main {
        position: fixed;
        inset: ${DESKTOP_TITLEBAR_HEIGHT}px 0 0;
        z-index: 1;
        display: grid;
        place-items: center;
      }

      .startup-icon {
        display: block;
        width: min(${STARTUP_ICON_SIZE_PX}px, 18vmin);
        height: min(${STARTUP_ICON_SIZE_PX}px, 18vmin);
        object-fit: contain;
        user-select: none;
        -webkit-user-drag: none;
        -webkit-app-region: no-drag;
        filter: drop-shadow(0 8px 18px rgba(0, 0, 0, 0.2));
      }

      .startup-error {
        position: fixed;
        right: 24px;
        bottom: 24px;
        left: 24px;
        max-height: 180px;
        padding: 12px 14px;
        overflow: auto;
        color: rgba(255, 255, 255, 0.86);
        font: 12px/1.5 system-ui, sans-serif;
        background: rgba(0, 0, 0, 0.42);
        border-radius: 8px;
        -webkit-app-region: no-drag;
      }

      .startup-error strong,
      .startup-error p { display: block; margin: 0; }
      .startup-error p { margin-top: 4px; color: rgba(255, 255, 255, 0.66); word-break: break-word; }

      /* The one action the failure page carries. Wording and tone follow the
       * renderer's retry strip; this document only states what Main answered. */
      .startup-retry {
        margin-top: 8px;
        padding: 3px 10px;
        color: inherit;
        font: inherit;
        background: transparent;
        border: 1px solid currentColor;
        border-radius: 6px;
        cursor: pointer;
      }

      .startup-retry:hover:not(:disabled) { background: rgba(255, 255, 255, 0.08); }
      .startup-retry:disabled { opacity: 0.7; cursor: default; }
      .startup-retry-note { color: rgba(255, 255, 255, 0.66); }
    </style>
  </head>
  <body>
    <div class="startup-drag-region" aria-hidden="true"></div>
    <main aria-label="LittleSheep">${icon}</main>
    ${error}
    <script>
      (() => {
        const region = document.querySelector('.startup-drag-region')
        const bridge = window.littlesheep
        if (!region || !bridge?.startWindowDrag) return
        let pointerId = null
        region.addEventListener('pointerdown', (event) => {
          if (event.button !== 0) return
          pointerId = event.pointerId
          region.setPointerCapture(pointerId)
          bridge.startWindowDrag({ screenX: event.screenX, screenY: event.screenY })
        })
        region.addEventListener('pointermove', (event) => {
          if (event.pointerId === pointerId) bridge.moveWindowDrag?.({ screenX: event.screenX, screenY: event.screenY })
        })
        const finishDrag = (event) => {
          if (event.pointerId !== pointerId) return
          if (region.hasPointerCapture(pointerId)) region.releasePointerCapture(pointerId)
          pointerId = null
          bridge.endWindowDrag?.()
        }
        region.addEventListener('pointerup', finishDrag)
        region.addEventListener('pointercancel', finishDrag)
      })()
    </script>
    <script>
      (() => {
        const button = document.querySelector('.startup-retry')
        if (!button) return
        const note = document.querySelector('.startup-retry-note')
        const bridge = window.littlesheep
        const say = (text) => { if (note) note.textContent = text }
        // A control that cannot reach Main is not offered at all: this page is the
        // last surface of a failed start, and a dead button would be worse than none.
        if (!bridge || typeof bridge.retryExecution !== 'function') {
          button.remove()
          return
        }

        button.addEventListener('click', async () => {
          button.disabled = true
          button.textContent = '正在重试…'
          say('')
          let outcome = null
          try {
            outcome = await bridge.retryExecution()
          } catch {
            outcome = null
          }
          button.textContent = '重试启动运行能力'
          if (!outcome) {
            say('重试请求没有送达主进程，请重启应用。')
            button.disabled = false
            return
          }
          const remaining = typeof outcome.attemptsRemaining === 'number' ? outcome.attemptsRemaining : 0
          if (outcome.accepted === false) {
            // Main refused: a retry is already running, or the budget is spent.
            // Either way this click was not an attempt and must not read as one.
            say(outcome.refusedBecause === 'exhausted'
              ? '重试次数已用完，请修复配置后重启应用。'
              : '上一次重试还在进行中。')
            button.disabled = outcome.refusedBecause === 'exhausted'
            return
          }
          if (outcome.reason) {
            button.disabled = remaining <= 0
            say(remaining <= 0
              ? '重试失败：' + outcome.reason + '（重试次数已用完，请重启应用）'
              : '重试失败：' + outcome.reason)
            return
          }
          // Accepted and it did not fail: Main has taken the window back and this
          // document is about to be replaced by the application renderer.
          say('重试成功，正在打开应用界面。')
        })
      })()
    </script>
  </body>
</html>`
}

export function createDesktopStartupPageUrl(
  iconDataUrl?: string,
  options?: DesktopStartupPageOptions,
): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(createDesktopStartupPageHtml(iconDataUrl, options))}`
}

function isPngDataUrl(value: string | undefined): value is string {
  return typeof value === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(value)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character)
}
