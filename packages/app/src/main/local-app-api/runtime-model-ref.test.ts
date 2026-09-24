import { describe, expect, it } from 'vitest'
import { ConfigSchema, type Config } from '@littlesheep/config'
import { validateModelRef } from './runtime-routes.js'

function configWith(providers: unknown[]): Config {
  return ConfigSchema.parse({
    version: 1,
    providers,
    agents: { defaults: { workspace: 'C:\\work', model: '' } },
  })
}

describe('runtime model reference validation', () => {
  it('accepts a model declared as metadata on a user provider', () => {
    // The provider editor writes declared models as objects, so the id has to be
    // resolved before it is compared: the composer offered this exact reference and
    // the comparison against the raw entries rejected it.
    const config = configWith([{
      id: 'acceptance-gw',
      name: '验收网关',
      baseURL: 'http://127.0.0.1:43210/v1',
      apiKey: 'acceptance-key',
      models: [{ id: 'slow-a' }, { id: 'slow-b', name: 'Slow B', contextWindow: 128_000 }],
    }])

    expect(validateModelRef(config, 'acceptance-gw/slow-a')).toBeNull()
    expect(validateModelRef(config, 'acceptance-gw/slow-b')).toBeNull()
    expect(validateModelRef(config, 'acceptance-gw/slow-c'))
      .toBe('model "slow-c" is not listed for provider "acceptance-gw"')
  })

  it('keeps the bare-id list working and does not police providers without models', () => {
    const config = configWith([
      {
        id: 'deepseek',
        name: 'DeepSeek',
        baseURL: 'https://api.deepseek.com',
        apiKey: 'key',
        models: ['deepseek-flash'],
      },
      {
        id: 'local-gw',
        name: 'Local',
        baseURL: 'http://127.0.0.1:1234/v1',
        apiKey: 'key',
        models: [],
      },
    ])

    expect(validateModelRef(config, 'deepseek/deepseek-flash')).toBeNull()
    expect(validateModelRef(config, 'deepseek/deepseek-v4-pro'))
      .toBe('model "deepseek-v4-pro" is not listed for provider "deepseek"')
    // An empty list declares nothing, so nothing is refused.
    expect(validateModelRef(config, 'local-gw/anything')).toBeNull()
  })

  it('still refuses unknown providers and providers without a usable key', () => {
    const previous = process.env['LITTLESHEEP_TEST_MISSING_KEY']
    delete process.env['LITTLESHEEP_TEST_MISSING_KEY']
    try {
      const config = configWith([
        {
          id: 'acceptance-gw',
          name: '验收网关',
          baseURL: 'http://127.0.0.1:43210/v1',
          apiKey: '$LITTLESHEEP_TEST_MISSING_KEY',
          models: [{ id: 'slow-a' }],
        },
      ])

      expect(validateModelRef(config, 'nope/slow-a')).toBe('unknown provider: nope')
      expect(validateModelRef(config, 'acceptance-gw/slow-a'))
        .toBe('provider "验收网关" has no API key yet')
    } finally {
      if (previous !== undefined) process.env['LITTLESHEEP_TEST_MISSING_KEY'] = previous
    }
  })
})
