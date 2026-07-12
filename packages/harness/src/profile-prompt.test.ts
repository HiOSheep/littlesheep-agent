import { describe, expect, it } from 'vitest'
import { appendSystemPromptAddons } from './profile-prompt.js'

describe('behavior profile prompt assembly', () => {
  it('leaves the system prompt unchanged without an active addon', () => {
    expect(appendSystemPromptAddons('base', undefined, '  ')).toBe('base')
  })

  it('appends profile and reasoning guidance as separate system sections', () => {
    expect(appendSystemPromptAddons('base', 'profile', 'reasoning')).toBe(
      'base\n\n---\n\nprofile\n\n---\n\nreasoning',
    )
  })
})
