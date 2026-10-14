// The renderer keeps its own copy of the protocol list (importing config's value
// would pull its Node-only loader into the renderer bundle), so the two copies are
// compared here. Without this, a protocol added to the schema would simply be
// missing from the UI — the failure mode is a dropdown that cannot express a
// provider the runtime accepts.

import { describe, expect, it } from 'vitest'
import { PROVIDER_API_PROTOCOLS } from '@littlesheep/config'
import {
  DEFAULT_PROVIDER_PROTOCOL,
  IMPLEMENTED_PROTOCOLS,
  PROVIDER_PROTOCOL_OPTIONS,
  isKnownProtocol,
  protocolHint,
  protocolLabel,
  protocolPath,
} from './provider-protocols'

describe('provider protocol options', () => {
  it('offers exactly the protocols the schema accepts, in the same order', () => {
    expect([...IMPLEMENTED_PROTOCOLS]).toEqual([...PROVIDER_API_PROTOCOLS])
    expect(PROVIDER_PROTOCOL_OPTIONS.map((option) => option.id)).toEqual([...PROVIDER_API_PROTOCOLS])
  })

  it('gives every protocol a label, a hint and a request path', () => {
    for (const option of PROVIDER_PROTOCOL_OPTIONS) {
      expect(option.label.length, `${option.id} label`).toBeGreaterThan(0)
      expect(option.hint.length, `${option.id} hint`).toBeGreaterThan(0)
      // The hint names the path so the address field's own help text can repeat it.
      expect(option.path.startsWith('/'), `${option.id} path`).toBe(true)
      expect(protocolPath(option.id)).toBe(option.path)
      expect(protocolLabel(option.id)).toBe(option.label)
      expect(protocolHint(option.id)).toBe(option.hint)
    }
  })

  it('defaults to the one protocol every OpenAI-compatible service speaks', () => {
    expect(DEFAULT_PROVIDER_PROTOCOL).toBe('openai-chat-completions')
    expect(PROVIDER_PROTOCOL_OPTIONS.filter((option) => option.isDefault).map((option) => option.id))
      .toEqual(['openai-chat-completions'])
  })

  it('names the right request path for each protocol', () => {
    // These are the vendor endpoints; a wrong one is a 404 at run time.
    expect(protocolPath('openai-chat-completions')).toBe('/chat/completions')
    expect(protocolPath('openai-responses')).toBe('/responses')
    expect(protocolPath('anthropic-messages')).toBe('/messages')
  })

  it('recognises only the protocols it offers', () => {
    for (const protocol of IMPLEMENTED_PROTOCOLS) expect(isKnownProtocol(protocol)).toBe(true)
    expect(isKnownProtocol('anthropic-messages-v2')).toBe(false)
    expect(isKnownProtocol('')).toBe(false)
  })
})
