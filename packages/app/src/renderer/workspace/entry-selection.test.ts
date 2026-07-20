import { describe, expect, it } from 'vitest'
import { resolveWorkspaceEntrySelection } from './entry-selection'

describe('workspace entry selection', () => {
  it('opens a blank browser tab from browser entry points', () => {
    expect(resolveWorkspaceEntrySelection('browser')).toEqual({
      kind: 'new-browser-tab',
      url: '',
    })
  })

  it('keeps other workspace entries as existing feature tabs', () => {
    expect(resolveWorkspaceEntrySelection('terminal')).toEqual({
      kind: 'open-tab',
      tab: 'terminal',
    })
  })
})
