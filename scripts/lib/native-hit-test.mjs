// Native hit-test probe: what the *window* does with a real mouse press at a
// point the renderer measured in CSS coordinates.
//
// Ownership: the Win32 `WM_NCHITTEST` probe and the coordinate conversion it
// needs. Callers own the points they ask about and the assertions they make
// about the answers; this module must not grow product budgets or per-gate
// control lists.
//
// Why it exists (2026-09-28, measured): `document.elementFromPoint` and
// `Input.dispatchMouseEvent` both answer a layer *above* the window's
// draggable region. The renderer publishes its `-webkit-app-region` boxes and
// Windows resolves them through the window's own `WM_NCHITTEST`, so a real
// press on a control that a drag surface covers returns `HTCAPTION` (2) and
// becomes a caption interaction — the page never sees the click. That is how
// the pinned window-chrome controls looked clickable in CDP, and to every DOM
// check, while a real click on them did nothing.
//
// Measured quirks kept from the implementation this was extracted from
// (`scripts/verify-window-layout.mjs`, `nativeHitTest`):
//   - the window is deliberately **not** moved. Moving it re-applies its
//     bounds through a DIP/physical round trip that ratchets its size about a
//     pixel per call, which breaks exact geometry assertions elsewhere in a
//     gate. A parked window answers correctly from where it is.
//   - points are CSS coordinates relative to the content area. `getContentBounds()`
//     is DIP, and the scale factor of the display the window sits on takes that
//     to the physical screen space `WM_NCHITTEST` speaks. The application pins
//     its zoom factor to 1 (`APPLICATION_ZOOM_FACTOR`), so CSS px map 1:1 to
//     DIP; a gate that changes zoom must scale its own points first.
//   - the probe runs `pwsh` with `SetProcessDpiAwarenessContext`, because an
//     unaware process gets virtualized coordinates back and the window is not
//     always on the primary display.
//   - **the window has to be one the OS still composites.** A hidden window, or
//     one moved entirely off every display, has no observable draggable region,
//     and `WM_NCHITTEST` then answers `HTCLIENT` everywhere on the chrome row —
//     measured 2026-09-28: a window parked with `setBounds({x:-32000,y:-32000})`
//     + `showInactive()` answered `HTCLIENT` at the titlebar's centre, while the
//     same point answered `HTCAPTION` once the window was on screen again, with
//     the renderer's `-webkit-app-region` boxes unchanged throughout. A gate that
//     parks its window and then asserts "this is still window chrome" is reading
//     a stale or absent region — it can pass for the wrong reason and fail for
//     the wrong reason. Show the window for the native half (inactively is
//     enough) and say so in the gate's own notes.
//
// `probe()` returns `undefined` where the platform cannot answer (not win32,
// or no window): a gate on another platform skips the native half explicitly
// instead of silently passing it.

import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Win32 `HT*` results this module names. The probe returns the raw value too. */
export const HTCLIENT = 1
export const HTCAPTION = 2
export const HTSYSMENU = 3
export const HTLEFT = 10
export const HTTOPLEFT = 13
export const HTMINBUTTON = 8
export const HTMAXBUTTON = 9
export const HTCLOSE = 20

/** The caption buttons the window's own title-bar overlay paints, not the page's. */
const CAPTION_BUTTONS = [HTSYSMENU, HTMINBUTTON, HTMAXBUTTON, HTCLOSE]

const HIT_NAMES = new Map([
  [0, 'HTNOWHERE'],
  [HTCLIENT, 'HTCLIENT'],
  [HTCAPTION, 'HTCAPTION'],
  [HTSYSMENU, 'HTSYSMENU'],
  [4, 'HTGROWBOX'],
  [5, 'HTMENU'],
  [6, 'HTHSCROLL'],
  [7, 'HTVSCROLL'],
  [HTMINBUTTON, 'HTMINBUTTON'],
  [HTMAXBUTTON, 'HTMAXBUTTON'],
  [10, 'HTLEFT'],
  [11, 'HTRIGHT'],
  [12, 'HTTOP'],
  [13, 'HTTOPLEFT'],
  [14, 'HTTOPRIGHT'],
  [15, 'HTBOTTOM'],
  [16, 'HTBOTTOMLEFT'],
  [17, 'HTBOTTOMRIGHT'],
  [18, 'HTBORDER'],
  [19, 'HTHELP'],
  [HTCLOSE, 'HTCLOSE'],
])

/** The three answers a window-chrome gate actually asks about. */
export function describeHit(hit) {
  if (hit === undefined || hit === null) return 'unavailable'
  if (hit === HTCLIENT) return 'client'
  if (hit === HTCAPTION) return 'caption'
  if (CAPTION_BUTTONS.includes(hit)) return 'caption-button'
  return 'other'
}

/** `HTCLIENT`: the window delivers the press to the page. */
export function isClientHit(hit) {
  return hit === HTCLIENT
}

/** `HTCAPTION`: the press is a window drag/menu interaction and never reaches the page. */
export function isCaptionHit(hit) {
  return hit === HTCAPTION
}

/** One of the native caption buttons the renderer's title-bar overlay paints. */
export function isCaptionButton(hit) {
  return CAPTION_BUTTONS.includes(hit)
}

export function describeHitName(hit) {
  if (hit === undefined || hit === null) return 'unavailable'
  return HIT_NAMES.get(hit) ?? `unknown(${hit})`
}

/**
 * The PowerShell the probe runs. Every value is embedded as a decimal literal
 * (`[int64]<digits>`) so nothing the renderer measured is re-parsed as a
 * string, and the points file path is single-quote escaped for the same
 * reason: a scratch path can legally contain a quote.
 */
export function nativeHitScript(hwnd, pointsPath) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace LsNativeHitTest -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
'@
[void][LsNativeHitTest.Native]::SetProcessDpiAwarenessContext([IntPtr](-4))
$points = Get-Content -Raw -LiteralPath '${pointsPath.replaceAll("'", "''")}' | ConvertFrom-Json
$out = foreach ($point in $points) {
  $packed = ((([int64]$point.y -band 0xFFFF) -shl 16) -bor ([int64]$point.x -band 0xFFFF))
  if ($packed -ge 0x80000000) { $packed -= 0x100000000 }
  [pscustomobject]@{ label = [string]$point.label; hit = [int64][LsNativeHitTest.Native]::SendMessage([IntPtr][int64]${hwnd}, 0x0084, [IntPtr]::Zero, [IntPtr][int64]$packed) }
}
ConvertTo-Json -InputObject @($out) -Compress
`
}

export function createNativeHitTest({
  /** A CDP client attached to the Electron main process. */
  main,
  /** Where the points file is written. Defaults to a fresh system-temp file. */
  pointsPath,
  /** `pwsh` by default; a caller may point at a specific PowerShell. */
  powerShell = 'pwsh',
  /**
   * Extra labels that stay unprobed are never a thing: every point is sent.
   * Overrides exist for the platform and for reading the window, so a caller
   * that does not install `layoutElectron`/`layoutWindow` is not stuck.
   */
  platform = process.platform,
  resolveGeometry: resolveGeometryOverride,
} = {}) {
  if (!main) throw new Error('native hit test needs a main-process CDP client')

  /**
   * The window handle and the conversion factors, read once per call so a gate
   * can assert "the window did not move" around the probe instead of trusting
   * it. Read-only: `getContentBounds`/`getBounds` never re-apply bounds.
   *
   * `layoutWindow`/`layoutElectron` are the two globals a gate installs in the
   * main process (see `scripts/verify-window-layout.mjs`); a caller that set up
   * something else can override this through `resolveGeometry`.
   */
  async function defaultResolveGeometry() {
    return main.evaluate(`(() => {
      const win = layoutWindow ?? layoutElectron.BrowserWindow.getAllWindows()[0];
      if (!win) return null;
      const content = win.getContentBounds();
      const scale = layoutElectron.screen.getDisplayMatching(win.getBounds()).scaleFactor;
      return { hwnd: win.getNativeWindowHandle().readBigUInt64LE(0).toString(), content, scale };
    })()`)
  }
  const resolveGeometry = resolveGeometryOverride ?? defaultResolveGeometry

  /** CSS coordinates (relative to the content area) to physical screen pixels. */
  function toPhysical(geometry, point) {
    return {
      label: String(point.label),
      x: Math.round((geometry.content.x + point.x) * geometry.scale),
      y: Math.round((geometry.content.y + point.y) * geometry.scale),
    }
  }

  /**
   * Ask the window about each point. Resolves to one entry per point:
   * `{ label, hit, name, kind, client, caption, captionButton, css, physical }`,
   * or `undefined` when this platform/window cannot answer.
   */
  async function probe(points) {
    // Checked before the platform guard on purpose: an empty point list means the
    // caller misread the contract, and that is a caller bug on every platform.
    if (!Array.isArray(points) || points.length === 0) throw new Error('native hit test needs at least one point')
    if (platform !== 'win32') return undefined
    const geometry = await resolveGeometry()
    if (!geometry) return undefined
    const physical = points.map((point) => toPhysical(geometry, point))
    const path = pointsPath ?? join(tmpdir(), `littlesheep-native-hit-points-${process.pid}-${Date.now()}.json`)
    await writeFile(path, JSON.stringify(physical))
    const stdout = execFileSync(
      powerShell,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', nativeHitScript(geometry.hwnd, path)],
      { encoding: 'utf8' },
    )
    const answers = new Map(JSON.parse(stdout).map((entry) => [entry.label, entry.hit]))
    return points.map((point, index) => {
      const hit = answers.get(String(point.label))
      return {
        label: String(point.label),
        hit,
        name: describeHitName(hit),
        kind: describeHit(hit),
        client: isClientHit(hit),
        caption: isCaptionHit(hit),
        captionButton: isCaptionButton(hit),
        css: { x: point.x, y: point.y },
        physical: { x: physical[index].x, y: physical[index].y },
      }
    })
  }

  /** `probe` as `{ [label]: hit }`, the shape the window-layout gate reports. */
  async function probeMap(points) {
    const entries = await probe(points)
    if (!entries) return undefined
    return Object.fromEntries(entries.map((entry) => [entry.label, entry.hit]))
  }

  /**
   * The assertion every chrome change owes: these controls must be reachable by
   * a real press at the point the renderer measured. `elementFromPoint` and a
   * CDP click are not substitutes — they are the checks this one exists to
   * falsify (see the module header).
   */
  async function assertClientHits(points, label) {
    const entries = await probe(points)
    if (!entries) return undefined
    for (const entry of entries) {
      if (entry.client) continue
      throw new Error(
        `${label}: a real mouse press on ${entry.label} is not delivered to the page `
        + `(win32 hit test ${entry.hit} ${entry.name} at css ${entry.css.x},${entry.css.y})`,
      )
    }
    return entries
  }

  /** The mirror assertion: these points must still be window chrome, not page content. */
  async function assertCaptionHits(points, label) {
    const entries = await probe(points)
    if (!entries) return undefined
    for (const entry of entries) {
      if (entry.caption) continue
      throw new Error(
        `${label}: ${entry.label} is no longer part of the window's draggable edge `
        + `(win32 hit test ${entry.hit} ${entry.name} at css ${entry.css.x},${entry.css.y})`,
      )
    }
    return entries
  }

  return { resolveGeometry, toPhysical, probe, probeMap, assertClientHits, assertCaptionHits }
}
