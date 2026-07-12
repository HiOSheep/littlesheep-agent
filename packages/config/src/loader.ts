// @littlesheep/config — loader.ts
// Load + validate + merge config.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { ConfigSchema, type Config } from './schema.js';
import { DEFAULT_CONFIG } from './defaults.js';

const CONFIG_FILENAME = 'config.json';
const MAX_WALK_UP = 6;

/**
 * Find config.json:
 *   1. explicit path
 *   2. LITTLESHEEP_CONFIG env
 *   3. <dataDir>/config.json (~/.littlesheep/config.json)
 *   4. walk up from cwd looking for .littlesheep/config.json
 *   5. walk up from cwd looking for littlesheep.config.json
 */
export function findConfigPath(dataDir?: string, start: string = process.cwd()): string | null {
  if (process.env.LITTLESHEEP_CONFIG && existsSync(process.env.LITTLESHEEP_CONFIG)) {
    return process.env.LITTLESHEEP_CONFIG;
  }
  // data dir (e.g. ~/.littlesheep/config.json)
  if (dataDir) {
    const inData = join(dataDir, CONFIG_FILENAME);
    if (existsSync(inData)) return inData;
  }
  // walk up
  let dir = resolve(start);
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const c1 = join(dir, '.littlesheep', CONFIG_FILENAME);
    if (existsSync(c1)) return c1;
    const c2 = join(dir, 'littlesheep.config.json');
    if (existsSync(c2)) return c2;
    const parent = dir;
    dir = resolve(dir, '..');
    if (dir === parent) break;
  }
  return null;
}

/** Load config from file. Falls back to DEFAULT_CONFIG if not found. */
export async function loadConfig(opts?: { configPath?: string; dataDir?: string }): Promise<Config> {
  const path = opts?.configPath ?? findConfigPath(opts?.dataDir);
  if (!path) return structuredClone(DEFAULT_CONFIG);
  const raw = await readFile(path, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    return ConfigSchema.parse(parsed); // zod validates + applies defaults
  } catch (err) {
    throw new Error(`config: failed to parse ${path}: ${(err as Error).message}`);
  }
}

/** Save config to file. */
export async function saveConfig(config: Config, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), 'utf8');
}

/** Resolve API key: if value starts with $, read from env. */
export function resolveApiKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.startsWith('$')) {
    return process.env[key.slice(1)];
  }
  return key;
}

/** Look up a provider by id. */
export function getProvider(config: Config, providerId: string): Config['providers'][number] | undefined {
  return config.providers.find((p) => p.id === providerId);
}

/** Parse a model ref "provider/model" into parts. */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const idx = ref.indexOf('/');
  if (idx < 0) throw new Error(`config: invalid model ref "${ref}" (expected "provider/model")`);
  return { provider: ref.slice(0, idx), model: ref.slice(idx + 1) };
}
