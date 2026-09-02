// Device/data-root local key used only for redacted cache-observation HMACs.
// The key is never included in RunContext checkpoints, execution logs or UI
// projections. A missing/corrupt key fails closed to an unavailable key rather
// than silently generating a new identity on every run.

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const CACHE_KEY_FILE = 'cache-observation.key';
const KEY_BYTES = 32;

export async function loadCacheObservationKey(dataRoot: string): Promise<string | null> {
  const path = join(dataRoot, 'config', CACHE_KEY_FILE);
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/iu.test(existing)) return existing;
  } catch {
    // First run or an unavailable data root. Creation below is best effort.
  }

  const candidate = randomBytes(KEY_BYTES).toString('hex');
  try {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, 'wx');
    try {
      await handle.writeFile(`${candidate}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    return candidate;
  } catch {
    // Another process may have won the first-run race. Re-read before giving
    // up so concurrent runners converge on one persisted identity.
    try {
      const existing = (await readFile(path, 'utf8')).trim();
      return /^[a-f0-9]{64}$/iu.test(existing) ? existing : null;
    } catch {
      return null;
    }
  }
}
