import { describe, expect, it } from 'vitest'
import {
  executionDisclosureDefaultOpen,
  executionDisclosureResetKey,
  verificationDisclosureDefaultOpen,
  verificationDisclosureResetKey,
} from './progressive-disclosure'

describe('progressive disclosure defaults', () => {
  it('keeps the current execution visible only while the task is running', () => {
    expect(executionDisclosureDefaultOpen('running')).toBe(true)
    expect(executionDisclosureDefaultOpen('done')).toBe(false)
    expect(executionDisclosureDefaultOpen('failed')).toBe(false)
    expect(executionDisclosureDefaultOpen('aborted')).toBe(false)
    expect(executionDisclosureDefaultOpen('paused')).toBe(false)
  })

  it('opens verification only while verification is active', () => {
    expect(verificationDisclosureDefaultOpen(true)).toBe(true)
    expect(verificationDisclosureDefaultOpen(false)).toBe(false)
  })

  it('changes reset keys when execution or verification state changes', () => {
    expect(executionDisclosureResetKey('running')).not.toBe(executionDisclosureResetKey('done'))
    expect(verificationDisclosureResetKey('running', true)).not.toBe(
      verificationDisclosureResetKey('done', false),
    )
  })
})
