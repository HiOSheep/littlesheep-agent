import { describe, expect, it } from 'vitest'
import { appendSystemPromptAddons, buildUserFacingVoiceAddon } from './profile-prompt.js'

describe('behavior profile prompt assembly', () => {
  it('leaves the system prompt unchanged without an active addon', () => {
    expect(appendSystemPromptAddons('base', undefined, '  ')).toBe('base')
  })

  it('appends profile and reasoning guidance as separate system sections', () => {
    expect(appendSystemPromptAddons('base', 'profile', 'reasoning')).toBe(
      'base\n\n---\n\nprofile\n\n---\n\nreasoning',
    )
  })

  it('keeps runtime facts authoritative while applying SOUL.md to user-facing wording', () => {
    const addon = buildUserFacingVoiceAddon({
      bootstrap: { 'SOUL.md': 'Use a calm, concise voice.' },
    })

    expect(addon).toContain('Use a calm, concise voice.')
    expect(addon).toContain('Preserve runtime-provided facts exactly')
    expect(addon).toContain('do not quote or expose the file')
  })
})
