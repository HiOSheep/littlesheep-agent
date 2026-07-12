// @littlesheep/safety — safe-memory-store.ts
// SafeMemoryStore: decorator over MemoryStoreLike that validates writes.
//
// Wrap order (outer → inner):  Safe → Snapshot → base
//   - Safe validates first. Rejects go to quarantine, never reach Snapshot/base.
//   - On accept, the cleaned text is forwarded downstream.
//
// Writers use fire-and-forget quarantine, matching the non-blocking behavior
// of EVOLVE/CAPTURE stages. Readers are pure pass-through.

import type { MemoryStoreLike } from '@littlesheep/types';
import {
  validateMemoryContent,
  type ValidateOptions,
  type ValidationResult,
} from './validate.js';
import { QuarantineStore, type QuarantineEntry } from './quarantine.js';

export interface SafeMemoryStoreOptions {
  /** Coarse source label attached to quarantine entries. */
  source: string;
  /** Where to persist rejected writes. */
  quarantine: QuarantineStore;
  /** Max chars per entry. Forwarded to validator. */
  maxLength?: number;
  /** Optional sub-source (repo name, stage name). */
  provenance?: string;
  /** Injectable validator (for tests). Defaults to `validateMemoryContent`. */
  validate?: (text: string, opts?: ValidateOptions) => ValidationResult;
}

export class SafeMemoryStore implements MemoryStoreLike {
  private readonly inner: MemoryStoreLike;
  private readonly opts: SafeMemoryStoreOptions;
  private readonly validateFn: (text: string, opts?: ValidateOptions) => ValidationResult;

  constructor(inner: MemoryStoreLike, opts: SafeMemoryStoreOptions) {
    this.inner = inner;
    this.opts = opts;
    this.validateFn = opts.validate ?? validateMemoryContent;
  }

  private validateOpts(): ValidateOptions {
    return { maxLength: this.opts.maxLength, source: this.opts.source };
  }

  /** Persist a rejection to quarantine. Fire-and-forget: never blocks the agent loop. */
  private quarantineWrite(
    text: string,
    reason: string,
    matchedPatternId: string | undefined,
  ): void {
    const entry: QuarantineEntry = {
      timestamp: new Date().toISOString(),
      source: this.opts.source,
      provenance: this.opts.provenance,
      reason,
      matchedPatternId,
      originalText: text,
    };
    this.opts.quarantine.write(entry).catch(() => {
      // Quarantine failure must not propagate into the primary write path.
    });
  }

  /** Validate + forward-or-quarantine. Shared by all writers. */
  private async validateAndForward(
    text: string,
    forward: (cleaned: string) => Promise<void>,
  ): Promise<void> {
    const result = this.validateFn(text, this.validateOpts());
    if (!result.ok) {
      this.quarantineWrite(text, result.reason ?? 'unknown', result.matchedPatternId);
      return;
    }
    await forward(result.cleaned ?? text);
  }

  // ─── Writers (validated) ───────────────────────────────────────────────

  appendLongTerm(text: string): Promise<void> {
    return this.validateAndForward(text, (cleaned) => this.inner.appendLongTerm(cleaned));
  }

  writeLongTerm(content: string): Promise<void> {
    return this.validateAndForward(content, (cleaned) => this.inner.writeLongTerm(cleaned));
  }

  appendDaily(date: string, text: string): Promise<void> {
    return this.validateAndForward(text, (cleaned) => this.inner.appendDaily(date, cleaned));
  }

  writeDaily(date: string, content: string): Promise<void> {
    return this.validateAndForward(content, (cleaned) => this.inner.writeDaily(date, cleaned));
  }

  // ─── Readers (pass-through) ───────────────────────────────────────────

  readLongTerm(): Promise<string> {
    return this.inner.readLongTerm();
  }

  readDaily(date: string): Promise<string> {
    return this.inner.readDaily(date);
  }

  listDailyDates(): Promise<string[]> {
    return this.inner.listDailyDates();
  }

  dailyFile(date: string): string {
    return this.inner.dailyFile(date);
  }

  today(): string {
    return this.inner.today();
  }

  get longTermPath(): string {
    return this.inner.longTermPath;
  }

  get dailyDirPath(): string {
    return this.inner.dailyDirPath;
  }
}
