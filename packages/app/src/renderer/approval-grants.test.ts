import { describe, expect, it } from 'vitest'
import {
  SessionApprovalGrantStore,
  approvalGrantKey,
  sessionApprovalScopeKey,
} from './approval-grants.js'

describe('session approval grants', () => {
  it('isolates grants by conversation, source, and operation type', () => {
    const grants = new SessionApprovalGrantStore()
    const first = sessionApprovalScopeKey('first')
    const second = sessionApprovalScopeKey('second')
    grants.grant(first, { source: 'agent', action: 'exec' })

    expect(grants.allows(first, { source: 'agent', action: 'exec' })).toBe(true)
    expect(grants.allows(first, { source: 'workspace', action: 'exec' })).toBe(false)
    expect(grants.allows(first, { source: 'agent', action: 'write' })).toBe(false)
    expect(grants.allows(second, { source: 'agent', action: 'exec' })).toBe(false)
  })

  it('promotes grants from a draft conversation to its real session id', () => {
    const grants = new SessionApprovalGrantStore()
    grants.grant('draft:new', { action: 'edit' })
    grants.grant('session:existing', { action: 'write' })

    grants.promote('draft:new', 'session:existing')

    expect(grants.allows('session:existing', { action: 'edit' })).toBe(true)
    expect(grants.allows('session:existing', { action: 'write' })).toBe(true)
    expect(grants.allows('draft:new', { action: 'edit' })).toBe(false)
  })

  it('normalizes action casing while retaining the source boundary', () => {
    expect(approvalGrantKey({ source: 'agent', action: ' Exec ' })).toBe('agent:exec')
  })

  it('revokes all temporary grants when their draft scope is abandoned', () => {
    const grants = new SessionApprovalGrantStore()
    grants.grant('draft:abandoned', { source: 'workspace', action: 'save_file' })

    grants.clear('draft:abandoned')

    expect(grants.allows('draft:abandoned', { source: 'workspace', action: 'save_file' })).toBe(false)
  })

  it('evicts old scopes instead of growing without a bound', () => {
    const grants = new SessionApprovalGrantStore()
    for (let index = 0; index < 140; index += 1) {
      grants.grant(`session:${index}`, { action: 'exec' })
    }

    expect(grants.allows('session:0', { action: 'exec' })).toBe(false)
    expect(grants.allows('session:139', { action: 'exec' })).toBe(true)
  })
})
