// @littlesheep/app — main/keychain.ts
// Encrypted API key storage using Electron safeStorage (DPAPI on Windows,
// Keychain on macOS, libsecret on Linux). Keys are stored as base64-encoded
// ciphertext in ~/.littlesheep/config/keys.json.
//
// On startup, loadApiKeys() decrypts all keys and injectKeysIntoEnv() sets
// them into process.env so that resolveApiKey("$VAR") in the config loader
// finds the real value — no config.json changes needed.

import { safeStorage } from 'electron'
import { join } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'

/** Encrypted key store: { envVarName: base64ciphertext } */
type EncryptedKeyStore = Record<string, string>

export interface ApiKeyDiagnostics {
  rawLength: number
  normalizedLength: number
  changedByNormalization: boolean
  hadBearerPrefix: boolean
  hadWrappingQuotes: boolean
  hadOuterWhitespace: boolean
  containsWhitespace: boolean
  containsControlCharacters: boolean
}

/** File path: <dataDir>/config/keys.json */
function keysFilePath(dataDir: string): string {
  return join(dataDir, 'config', 'keys.json')
}

export function normalizeApiKey(value: string): string {
  let normalized = value.trim()
  if (
    normalized.length >= 2
    && ((normalized.startsWith('"') && normalized.endsWith('"'))
      || (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    normalized = normalized.slice(1, -1).trim()
  }
  normalized = normalized.replace(/^Bearer\s+/i, '').trim()
  return normalized
}

export function inspectApiKey(value: string): ApiKeyDiagnostics {
  const trimmed = value.trim()
  const hadWrappingQuotes = trimmed.length >= 2 && (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )
  const unquoted = hadWrappingQuotes ? trimmed.slice(1, -1).trim() : trimmed
  const normalized = normalizeApiKey(value)
  return {
    rawLength: value.length,
    normalizedLength: normalized.length,
    changedByNormalization: normalized !== value,
    hadBearerPrefix: /^Bearer\s+/i.test(unquoted),
    hadWrappingQuotes,
    hadOuterWhitespace: value !== trimmed,
    containsWhitespace: /\s/.test(normalized),
    containsControlCharacters: [...normalized].some((character) => /[\u0000-\u001f\u007f]/.test(character)),
  }
}

/**
 * Encrypt a plaintext key → base64 string.
 * Falls back to base64 encoding (not encryption) if safeStorage is unavailable.
 */
function encrypt(plaintext: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plaintext).toString('base64')
  }
  // Fallback: base64 encode (NOT secure, just obfuscated)
  console.warn('keychain: safeStorage not available, storing key as plain base64')
  return Buffer.from(plaintext, 'utf8').toString('base64')
}

/**
 * Decrypt a base64 string → plaintext key.
 * Returns null on failure (e.g., key was encrypted on another machine/account).
 */
function decrypt(b64: string): string | null {
  const encoded = Buffer.from(b64, 'base64')
  // Try safeStorage decryption first
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(encoded)
    } catch {
      // Might be a plain base64 fallback string, or encrypted on another account
      // Fall through to plain base64 attempt
    }
  }
  // Fallback: plain base64 decode
  try {
    const candidate = encoded.toString('utf8')
    return isPlausibleApiKey(candidate) ? candidate : null
  } catch {
    return null
  }
}

function isPlausibleApiKey(value: string): boolean {
  const normalized = normalizeApiKey(value)
  return normalized.length >= 8
    && normalized.length <= 4_096
    && !/\s/.test(normalized)
    && !normalized.includes('\uFFFD')
    && ![...normalized].some((character) => /[\u0000-\u001f\u007f]/.test(character))
}

/**
 * Load all API keys from keys.json and decrypt them.
 * Returns {} if the file doesn't exist or is empty.
 * Skips entries that fail decryption (with a warning), never throws.
 */
export function loadApiKeys(dataDir: string): Record<string, string> {
  const path = keysFilePath(dataDir)
  if (!existsSync(path)) return {}

  try {
    const raw = readFileSyncCompat(path)
    const store = JSON.parse(raw) as EncryptedKeyStore
    const result: Record<string, string> = {}
    for (const [envVar, b64] of Object.entries(store)) {
      const plaintext = decrypt(b64)
      const normalized = plaintext ? normalizeApiKey(plaintext) : ''
      if (normalized) {
        result[envVar] = normalized
      } else {
        console.warn(`keychain: failed to decrypt key for ${envVar}, skipping`)
      }
    }
    return result
  } catch (e) {
    console.warn(`keychain: failed to read keys.json: ${(e as Error).message}`)
    return {}
  }
}

/**
 * Save a single API key (encrypted) to keys.json.
 * Merges with existing keys; creates the config dir if needed.
 */
export async function saveApiKey(
  dataDir: string,
  envVarName: string,
  plaintextKey: string,
): Promise<void> {
  const normalizedKey = normalizeApiKey(plaintextKey)
  if (!normalizedKey) throw new Error('API key cannot be empty')
  if (/\s/.test(normalizedKey)) throw new Error('API key cannot contain whitespace')

  const path = keysFilePath(dataDir)
  const dir = join(dataDir, 'config')

  // Read existing store (or start empty)
  let store: EncryptedKeyStore = {}
  if (existsSync(path)) {
    try {
      const raw = readFileSyncCompat(path)
      store = JSON.parse(raw) as EncryptedKeyStore
    } catch {
      // Corrupted file — start fresh
      store = {}
    }
  }

  // Encrypt and merge
  store[envVarName] = encrypt(normalizedKey)

  // Write atomically (mkdir + write)
  await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify(store, null, 2), 'utf8')
}

/**
 * Inject decrypted keys into process.env.
 * Each key: process.env[envVarName] = plaintextValue.
 * Does NOT delete existing env vars — only sets/overwrites.
 */
export function injectKeysIntoEnv(keys: Record<string, string>): void {
  for (const [envVar, value] of Object.entries(keys)) {
    const normalized = normalizeApiKey(value)
    if (normalized) process.env[envVar] = normalized
  }
}

/**
 * Derive the env var name from a provider's apiKey field.
 *
 * - "$DEEPSEEK_API_KEY" → "DEEPSEEK_API_KEY" (env var reference)
 * - "sk-xxx" (literal) → null (hardcoded, cannot edit via UI)
 * - undefined → null (no apiKey field in config)
 *
 * Returns null for non-env-var keys, meaning the UI should show
 * the key as non-editable.
 */
export function deriveEnvVarName(apiKey: string | undefined): string | null {
  if (!apiKey) return null
  if (apiKey.startsWith('$')) return apiKey.slice(1)
  return null // literal key, not an env var reference
}

/**
 * Canonical keychain entry name for a provider id.
 *
 * "my-gw" → "MY_GW_API_KEY". The settings page stores plaintext keys here and
 * keeps only the "$MY_GW_API_KEY" reference in config.json, so provider
 * credentials never enter the config file or the renderer payload.
 */
export function deriveProviderKeyEnvVar(providerId: string): string {
  const slug = providerId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${slug || 'PROVIDER'}_API_KEY`
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Synchronous read for use in non-async contexts (loadApiKeys). */
function readFileSyncCompat(path: string): string {
  return readFileSync(path, 'utf8')
}
