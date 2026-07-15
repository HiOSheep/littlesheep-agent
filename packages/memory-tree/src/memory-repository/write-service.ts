import type { MemoryWriteIntent, MemoryWriteResult } from '../types.js';
import type { MemoryWriteServiceOptions } from './contracts.js';

export class MemoryWriteService {
  private readonly repository: MemoryWriteServiceOptions['repository'];
  private readonly invalidate: MemoryWriteServiceOptions['invalidate'];
  private readonly log: MemoryWriteServiceOptions['log'];

  constructor(options: MemoryWriteServiceOptions) {
    this.repository = options.repository;
    this.invalidate = options.invalidate;
    this.log = options.log;
  }

  async write(intent: MemoryWriteIntent): Promise<MemoryWriteResult> {
    const result = await this.repository.write(intent);
    if (result.decision === 'created' || result.decision === 'merged' || result.decision === 'reinforced') {
      try {
        await this.invalidate(intent.branch);
      } catch (error) {
        this.log?.('warn', `memory-tree: post-write invalidation failed: ${(error as Error).message}`);
      }
    }
    return result;
  }

  async writeMany(intents: MemoryWriteIntent[]): Promise<MemoryWriteResult[]> {
    const results: MemoryWriteResult[] = [];
    for (const intent of intents) {
      try {
        results.push(await this.write(intent));
      } catch (error) {
        this.log?.('warn', `memory-tree: write failed for ${intent.branch}: ${(error as Error).message}`);
        results.push({
          intentId: intent.id ?? 'unknown',
          decision: 'queued',
          reason: `Write failed before persistence: ${(error as Error).message}`,
        });
      }
    }
    return results;
  }
}

export type MemoryWriteServiceLike = Pick<MemoryWriteService, 'write' | 'writeMany'>;
