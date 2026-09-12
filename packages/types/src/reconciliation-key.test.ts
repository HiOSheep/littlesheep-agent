import { describe, expect, it } from 'vitest'
import {
  RECONCILIATION_KEY_MAX_BYTES,
  RECONCILIATION_KEY_MAX_FIELDS,
  RECONCILIATION_KEY_MAX_STRING,
  boundReconciliationKey,
  reconciliationKeyFits,
} from './reconciliation-key.js'

describe('bounded reconciliation keys', () => {
  it('accepts scalars, scalar arrays and flat scalar objects', () => {
    expect(boundReconciliationKey('external-id-1')).toBe('external-id-1')
    expect(boundReconciliationKey(7)).toBe(7)
    expect(boundReconciliationKey(false)).toBe(false)
    expect(boundReconciliationKey(['a', 1, true, null])).toEqual(['a', 1, true, null])
    expect(boundReconciliationKey({
      path: '/tmp/report.txt',
      sha256: 'a'.repeat(64),
      attempt: 2,
      ids: ['one', 'two'],
      dryRun: false,
    })).toEqual({
      path: '/tmp/report.txt',
      sha256: 'a'.repeat(64),
      attempt: 2,
      ids: ['one', 'two'],
      dryRun: false,
    })
  })

  it('drops anything that is not a bounded, plain value', () => {
    expect(boundReconciliationKey(undefined)).toBeUndefined()
    expect(boundReconciliationKey(null)).toBeUndefined()
    expect(boundReconciliationKey(Number.NaN)).toBeUndefined()
    expect(boundReconciliationKey(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(boundReconciliationKey({ nested: { deep: 'value' } })).toBeUndefined()
    expect(boundReconciliationKey([{ key: 'value' }])).toBeUndefined()
    expect(boundReconciliationKey(new Date())).toBeUndefined()
    expect(boundReconciliationKey({ fn: () => 1 })).toBeUndefined()
    expect(boundReconciliationKey({})).toBeUndefined()
  })

  it('enforces the string, field-count and serialized-size limits', () => {
    expect(boundReconciliationKey({ long: 'x'.repeat(RECONCILIATION_KEY_MAX_STRING + 1) })).toBeUndefined()
    expect(boundReconciliationKey({ control: 'a\u0000b' })).toBeUndefined()

    const tooManyFields: Record<string, string> = {}
    for (let index = 0; index <= RECONCILIATION_KEY_MAX_FIELDS; index += 1) tooManyFields[`k${index}`] = 'v'
    expect(boundReconciliationKey(tooManyFields)).toBeUndefined()

    const oversized = { blob: 'x'.repeat(RECONCILIATION_KEY_MAX_BYTES) }
    expect(boundReconciliationKey(oversized)).toBeUndefined()
  })

  it('rejects cyclic and prototype-carrying values', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(boundReconciliationKey(cyclic)).toBeUndefined()

    class Carrier {
      path = '/tmp/a'
    }
    expect(boundReconciliationKey(new Carrier())).toBeUndefined()
  })

  it('keeps the serialized-size guard in sync with acceptance', () => {
    expect(reconciliationKeyFits({ path: '/tmp/a' })).toBe(true)
    expect(reconciliationKeyFits({ path: 'x'.repeat(RECONCILIATION_KEY_MAX_BYTES) })).toBe(false)
  })
})
