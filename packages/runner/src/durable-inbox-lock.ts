// Process-serialized, cross-process file-locked critical section for the durable inbox.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLock } from '@littlesheep/session';

/**
 * One write lock per inbox. `run` takes the cross-process lock for a single
 * operation; `batch` holds it across several public operations so durable
 * ingress does not pay a lock cycle for enqueue, claim and complete separately.
 */
export class InboxWriteLock {
  private tail: Promise<void> = Promise.resolve();
  private batchActive = false;

  constructor(private readonly rootDir: string) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.batchActive) return operation();
    const current = this.tail.catch(() => undefined).then(async () => {
      await mkdir(this.rootDir, { recursive: true });
      const lock = await acquireLock(join(this.rootDir, '.inbox'), 60_000);
      try {
        return await operation();
      } finally {
        await lock.release();
      }
    });
    this.tail = current.then(() => undefined, () => undefined);
    return current;
  }

  batch<T>(operation: () => Promise<T>): Promise<T> {
    if (this.batchActive) return operation();
    return this.run(async () => {
      this.batchActive = true;
      try {
        return await operation();
      } finally {
        this.batchActive = false;
      }
    });
  }
}
