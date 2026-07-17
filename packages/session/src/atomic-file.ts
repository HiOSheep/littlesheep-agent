import { randomBytes } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';

const RENAME_RETRIES = 8;

export async function atomicWriteText(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, content, 'utf8');
    let delay = 2;
    let lastError: unknown;
    for (let attempt = 0; attempt < RENAME_RETRIES; attempt += 1) {
      try {
        await rename(temporary, path);
        return;
      } catch (error) {
        lastError = error;
        if (!isRenameRetryError(error) || attempt === RENAME_RETRIES - 1) break;
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 50);
      }
    }
    throw lastError;
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function isRenameRetryError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
  return code === 'EPERM' || code === 'EACCES';
}
