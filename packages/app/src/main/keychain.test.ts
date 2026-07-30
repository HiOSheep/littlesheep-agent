import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { encryptString, decryptString } = vi.hoisted(() => ({
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, 'utf8')),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')),
}))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString,
    decryptString,
  },
}))

import { injectKeysIntoEnv, inspectApiKey, loadApiKeys, normalizeApiKey, saveApiKey } from './keychain.js'

describe('provider API key normalization', () => {
  beforeEach(() => {
    delete process.env.TEST_PROVIDER_API_KEY
  })

  it('removes copy-paste wrappers without changing the credential body', () => {
    expect(normalizeApiKey('  "Bearer sk-example"\r\n')).toBe('sk-example')
    expect(normalizeApiKey("'sk-example'")).toBe('sk-example')
  })

  it('reports only non-secret credential characteristics', () => {
    expect(inspectApiKey('  Bearer sk-example\n')).toEqual({
      rawLength: 20,
      normalizedLength: 10,
      changedByNormalization: true,
      hadBearerPrefix: true,
      hadWrappingQuotes: false,
      hadOuterWhitespace: true,
      containsWhitespace: false,
      containsControlCharacters: false,
    })
  })

  it('normalizes values before injecting them into the process environment', () => {
    injectKeysIntoEnv({ TEST_PROVIDER_API_KEY: '  Bearer sk-example  ' })
    expect(process.env.TEST_PROVIDER_API_KEY).toBe('sk-example')
  })

  it('persists and reloads only the normalized credential', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ls-keychain-'))
    try {
      await saveApiKey(dir, 'TEST_PROVIDER_API_KEY', '  "Bearer sk-example"  ')
      expect(encryptString).toHaveBeenLastCalledWith('sk-example')
      expect(loadApiKeys(dir)).toEqual({ TEST_PROVIDER_API_KEY: 'sk-example' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects credentials that still contain whitespace after normalization', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ls-keychain-'))
    try {
      await expect(saveApiKey(dir, 'TEST_PROVIDER_API_KEY', 'sk-invalid key'))
        .rejects.toThrow('cannot contain whitespace')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not reinterpret failed encrypted bytes as a plaintext credential', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ls-keychain-'))
    try {
      await mkdir(join(dir, 'config'), { recursive: true })
      await writeFile(join(dir, 'config', 'keys.json'), JSON.stringify({
        TEST_PROVIDER_API_KEY: Buffer.from([0xff, 0x00, 0x13, 0x37]).toString('base64'),
      }), 'utf8')
      decryptString.mockImplementationOnce(() => {
        throw new Error('cannot decrypt')
      })
      expect(loadApiKeys(dir)).toEqual({})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
