import { describe, expect, it } from 'vitest'
import { GENERAL_PROFILE } from '@littlesheep/prompt'
import {
  appendSystemPromptAddons,
  buildCompactBehaviorProfileAddon,
  buildUserFacingVoiceAddon,
} from './profile-prompt.js'

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

  it('uses a shorter built-in profile while keeping permission policy runtime-owned', () => {
    const addon = buildCompactBehaviorProfileAddon({
      profilePromptAddon: GENERAL_PROFILE.systemPromptAddon,
      resolvedRunConfig: { behaviorModeId: 'general' } as never,
    })

    expect(addon).toBe(GENERAL_PROFILE.compactSystemPromptAddon)
    expect(addon).toContain('never grants tool permission')
    expect(addon!.length).toBeLessThan(GENERAL_PROFILE.systemPromptAddon.length)
  })

  it('does not rewrite a custom profile addon into a built-in profile', () => {
    expect(buildCompactBehaviorProfileAddon({
      profilePromptAddon: 'CUSTOM_PROFILE_SENTINEL',
      resolvedRunConfig: { behaviorModeId: 'general' } as never,
    })).toBe('CUSTOM_PROFILE_SENTINEL')
  })
})
