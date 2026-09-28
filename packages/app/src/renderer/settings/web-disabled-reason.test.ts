import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { webProviderCheckBlockedReason, type WebProviderCheckGate } from './web-state'

const READ_MODES: Array<WebProviderCheckGate['readMode']> = ['public_anonymous', 'configured_allowlist', 'disabled']

function gate(overrides: Partial<WebProviderCheckGate> = {}): WebProviderCheckGate {
  return {
    checking: false,
    savingKey: false,
    providerConfigured: true,
    enabled: true,
    readMode: 'public_anonymous',
    ...overrides,
  }
}

/** The five terms the button used to be disabled by, with no reason published. */
function legacyDisabled(entry: WebProviderCheckGate): boolean {
  return entry.checking || entry.savingKey || !entry.providerConfigured || !entry.enabled || entry.readMode === 'disabled'
}

function allGates(): WebProviderCheckGate[] {
  const gates: WebProviderCheckGate[] = []
  for (const checking of [false, true]) {
    for (const savingKey of [false, true]) {
      for (const providerConfigured of [false, true]) {
        for (const enabled of [false, true]) {
          for (const readMode of READ_MODES) {
            gates.push({ checking, savingKey, providerConfigured, enabled, readMode })
          }
        }
      }
    }
  }
  return gates
}

describe('provider check disabled reason', () => {
  it('answers for every combination of the five facts, and only when the control is disabled', () => {
    for (const entry of allGates()) {
      const reason = webProviderCheckBlockedReason(entry)
      // This is the assertion that keeps the reason and the disabled state from
      // drifting apart: the button is disabled exactly when a reason exists.
      expect(reason !== null, JSON.stringify(entry)).toBe(legacyDisabled(entry))
      if (reason !== null) {
        expect(reason.length, JSON.stringify(entry)).toBeGreaterThan(6)
        expect(reason.endsWith('。'), JSON.stringify(entry)).toBe(true)
      }
    }
  })

  it('names the specific fact instead of one generic sentence', () => {
    const reasons = [
      webProviderCheckBlockedReason(gate({ checking: true })),
      webProviderCheckBlockedReason(gate({ savingKey: true })),
      webProviderCheckBlockedReason(gate({ providerConfigured: false })),
      webProviderCheckBlockedReason(gate({ enabled: false })),
      webProviderCheckBlockedReason(gate({ readMode: 'disabled' })),
    ]
    expect(reasons.every((reason) => reason !== null)).toBe(true)
    expect(new Set(reasons).size).toBe(5)
    // Busy beats the configuration facts: while a check runs, that is the reason.
    expect(webProviderCheckBlockedReason(gate({ checking: true, providerConfigured: false })))
      .toContain('正在检查')
  })

  it('publishes the reason on the control instead of leaving it greyed out', async () => {
    const page = await readFile(new URL('./web.tsx', import.meta.url), 'utf8')

    // Both the disabled state and the published text come from the same judgement.
    expect(page).not.toContain("disabled={checkingProvider || savingProvider")
    expect(page).toContain('disabled={checkBlockedReason !== null}')
    expect(page).toContain('aria-describedby={checkBlockedReason ?')
    expect(page).toContain('title={checkBlockedReason ?? undefined}')
    expect(page).toContain('id="web-provider-check-reason"')
    // The reason is visible text, not only a tooltip: a disabled control does not
    // receive pointer events, so `title` alone is not inspectable.
    expect(page).toContain('{checkBlockedReason && (')
  })
})
