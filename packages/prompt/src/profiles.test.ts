import { describe, expect, it } from 'vitest'
import {
  CODING_PROFILE,
  GENERAL_PROFILE,
  getAgentProfile,
  normalizeAgentProfileId,
} from './profiles.js'

describe('agent behavior profiles', () => {
  it('defines separate general and coding system-prompt behavior', () => {
    expect(GENERAL_PROFILE.systemPromptAddon).toContain('Behavior Profile: General')
    expect(CODING_PROFILE.systemPromptAddon).toContain('Behavior Profile: Coding')
    expect(CODING_PROFILE.systemPromptAddon).toContain('senior software engineer')
  })

  it('keeps profile prompts explicit that permissions remain runtime-owned', () => {
    expect(GENERAL_PROFILE.systemPromptAddon).toContain('never grants tool permission')
    expect(CODING_PROFILE.systemPromptAddon).toContain('never grants tool permission')
  })

  it('normalizes unknown profiles to general', () => {
    expect(getAgentProfile('coding')?.id).toBe('coding')
    expect(normalizeAgentProfileId('unknown')).toBe('general')
  })
})
