import { describe, expect, it } from 'vitest'
import { GENERAL_PROFILE, buildSystemPromptBundle, CACHE_BOUNDARY_MARKER, splitAtBoundary } from '@littlesheep/prompt'
import { DEFAULT_BRANDING } from '@littlesheep/branding'
import {
  appendSystemPromptAddons,
  appendSystemPromptBundleAddons,
  buildCompactBehaviorProfileAddon,
  buildUserFacingVoiceAddon,
} from './profile-prompt.js'

describe('behavior profile prompt assembly', () => {
  it('leaves the system prompt unchanged without an active addon', () => {
    expect(appendSystemPromptAddons('base', undefined, '  ')).toBe('base')
  })

  it('appends profile and reasoning guidance as separate system sections', () => {
    expect(appendSystemPromptAddons('base', 'profile', 'reasoning')).toBe(
      `base\n\n${CACHE_BOUNDARY_MARKER}\n\nprofile\n\n---\n\nreasoning`,
    )
  })

  it('keeps stable raw addons before the boundary and volatile addons after it', () => {
    expect(appendSystemPromptAddons(
      'base',
      { id: 'profile', text: 'stable profile', placement: 'stable' },
      { id: 'voice', text: 'volatile voice' },
    )).toBe(`base\n\n---\n\nstable profile\n\n${CACHE_BOUNDARY_MARKER}\n\nvolatile voice`)
  })

  it('places stable addons before the cache boundary and run facts after it', () => {
    const base = buildSystemPromptBundle({
      branding: DEFAULT_BRANDING,
      tools: [],
      workspace: '/tmp/ws',
      bootstrap: {},
      memoryRootIndex: 'volatile memory',
      mode: 'full',
    })
    const result = appendSystemPromptBundleAddons(base, [
      { id: 'profile', text: 'stable profile', placement: 'stable' },
      { id: 'task', text: 'run task facts' },
    ])
    const parts = splitAtBoundary(result.text)
    expect(parts.stable).toContain('stable profile')
    expect(parts.stable).not.toContain('run task facts')
    expect(parts.volatile).toContain('run task facts')
    expect(result.segments.find((segment) => segment.id === 'profile')?.text).not.toContain(CACHE_BOUNDARY_MARKER)
    expect(result.text).toContain(CACHE_BOUNDARY_MARKER)
    // The marker travels with the first section below the boundary, which is now a
    // purpose section from the bundle rather than the memory index.
    expect(result.segments.some((segment) => segment.text.includes(CACHE_BOUNDARY_MARKER))).toBe(true)
    expect(result.segments.find((segment) => segment.id === 'memory-root-index')).toBeDefined()
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

  it('keeps the bundle honest about its own stable half after adding sections', () => {
    const base = buildSystemPromptBundle({
      branding: DEFAULT_BRANDING,
      tools: [],
      workspace: '/tmp/ws',
      bootstrap: {},
      mode: 'full',
    })
    const withAddons = appendSystemPromptBundleAddons(base, [
      { id: 'profile', text: 'stable profile', placement: 'stable' },
      { id: 'voice', text: 'volatile voice' },
    ])

    // `stableText` and `trailingSegments` have to describe the same split that
    // `text` encodes. Leaving them undefined here made REPLY send the whole
    // prompt as the system message while EXECUTE sent only the stable half.
    expect(withAddons.stableText).toBeDefined()
    expect(withAddons.trailingSegments).toBeDefined()
    expect(`${withAddons.stableText}${withAddons.trailingSegments!.map((segment) => segment.text).join('')}`)
      .toBe(withAddons.text)
    expect(withAddons.stableText).toContain('stable profile')
    expect(withAddons.stableText).not.toContain('volatile voice')
    expect(withAddons.stableText).not.toContain(CACHE_BOUNDARY_MARKER)
    expect(withAddons.trailingSegments!.map((segment) => segment.text).join(''))
      .toContain('volatile voice')
  })

  it('marks a caller-owned section as trailing so the tail owner can emit it once', () => {
    const base = buildSystemPromptBundle({
      branding: DEFAULT_BRANDING,
      tools: [],
      workspace: '/tmp/ws',
      bootstrap: {},
      mode: 'full',
    })
    const withAddons = appendSystemPromptBundleAddons(base, [
      { id: 'retrieval-intent-contract', text: 'intent none', appendOnly: true },
    ])

    const segment = withAddons.segments.find((item) => item.id === 'retrieval-intent-contract')
    expect(segment?.placement).toBe('trailing')
    // A tail-owned section stays below the boundary; the append-only owner emits
    // it as its own message rather than folding it into the system prompt.
    expect(withAddons.trailingSegments?.some((item) => item.id === 'retrieval-intent-contract'))
      .toBe(true)
    expect(withAddons.stableText).not.toContain('intent none')
  })
})
