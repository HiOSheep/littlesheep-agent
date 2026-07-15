// Serializes migration and rollback requests without retaining completed operation promises.

export class MemoryV3MigrationOperationQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.tail.catch(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.tail = prior.then(() => gate);
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
