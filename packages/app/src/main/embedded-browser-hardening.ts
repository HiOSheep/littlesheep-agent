// Hard constraints for guest webviews, applied in Main.
//
// The renderer declares what it *wants* a guest to be (`<webview webpreferences=…>`),
// and that declaration is part of the renderer's attack surface: a compromised or
// simply wrong renderer could attach a guest with node integration, a preload that
// hands over the LS bridge, or another session partition. UX-26 asks to "复核 guest
// 创建和导航时的 Main 硬约束，不能只信 Renderer 的 webpreferences", so Main rewrites
// the preferences at attach time and refuses attachments that cannot be made safe.
//
// The function is pure (plain objects in, decision out) so the rules are testable
// without Electron; `embedded-browser.ts` is only the wiring.

import { EMBEDDED_BROWSER_PARTITION } from '../shared/browser-control-contracts.js'

/** Preferences a guest must never keep, whatever the renderer asked for. */
const FORCED_WEB_PREFERENCES = {
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  plugins: false,
} as const

export interface GuestAttachInput {
  /** Mutable preferences object Electron hands to `will-attach-webview`. */
  webPreferences: Record<string, unknown>
  /** The attach parameters, of which only the source matters here. */
  params: { src?: string }
}

export interface GuestAttachDecision {
  /** False means the caller must `event.preventDefault()`. */
  allowed: boolean
  /** Why an attachment was refused. */
  reason?: string
  /** Field names Main had to correct, for the warning log. */
  corrections: string[]
}

/** Attachment sources that are acceptable: the renderer's placeholder or HTTP(S). */
export function isAllowedGuestSource(src: string | undefined): boolean {
  const value = (src ?? '').trim()
  if (!value || value === 'about:blank') return true
  return /^https?:\/\//iu.test(value)
}

/**
 * Rewrite a guest's preferences to the only shape LS runs guests in.
 *
 * Everything that could reach the LS bridge, the Node API, another browser profile
 * or the host document is removed rather than merely not requested. `preload` and
 * `additionalArguments` are deleted outright — a preload is how the LS bridge would
 * be handed to a web page.
 */
export function hardenGuestAttach(input: GuestAttachInput): GuestAttachDecision {
  const corrections: string[] = []
  if (!isAllowedGuestSource(input.params.src)) {
    return {
      allowed: false,
      reason: `guest source is not http(s): ${String(input.params.src).slice(0, 120)}`,
      corrections,
    }
  }

  const preferences = input.webPreferences
  for (const [key, value] of Object.entries(FORCED_WEB_PREFERENCES)) {
    if (preferences[key] !== value) {
      preferences[key] = value
      corrections.push(key)
    }
  }
  if (preferences['partition'] !== EMBEDDED_BROWSER_PARTITION) {
    preferences['partition'] = EMBEDDED_BROWSER_PARTITION
    corrections.push('partition')
  }
  for (const key of ['preload', 'preloadURL', 'additionalArguments'] as const) {
    if (preferences[key] !== undefined) {
      delete preferences[key]
      corrections.push(key)
    }
  }

  return { allowed: true, corrections }
}
