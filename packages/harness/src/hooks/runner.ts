// @littlesheep/harness — hooks/runner.ts
// HookRunner: executes the three hook models (void / modifying / claiming)
// with priority-ordered, registration-stable ordering.
//
// Execution models:
//   void      — observe only, no mutation, no return. Errors → log + continue.
//   modifying — may mutate ctx (before) or replace the StageResult (after).
//               Errors → log + degrade (treat as no-op).
//   claiming  — before-only. May return a StageResult to replace the default
//               stage entirely (Layer 2 equivalent). First non-null wins.
//               Errors → log + treat as not-claimed.
//
// Ordering within a phase: void → modifying → claiming (before).
// After: void → modifying. Higher priority runs first; ties keep
// registration order.

import type { AnyHook, RunContext, StageResult, StageName } from '@littlesheep/types';

/** Logger sink type (mirrors ToolContext.log). */
type Log = (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

export class HookRunner {
  private hooks: AnyHook[] = [];
  private readonly order = new WeakMap<AnyHook, number>();
  private counter = 0;
  private readonly log: Log;

  constructor(log?: Log) {
    this.log = log ?? ((lvl, msg) => console.error(`[hookrunner:${lvl}] ${msg}`));
  }

  /** Register a hook. Later registration = lower precedence at equal priority. */
  register(hook: AnyHook): void {
    this.order.set(hook, this.counter++);
    this.hooks.push(hook);
  }

  /** All hooks matching a stage (for inspection/debugging). */
  hooksFor(stage: StageName): AnyHook[] {
    return this.hooks.filter((h) => this.matches(h, stage));
  }

  /**
   * Run before-stage hooks. Returns { claimed } if a claiming hook produced
   * a replacement StageResult (default stage should be skipped).
   */
  async runBefore(ctx: RunContext, stage: StageName): Promise<{ claimed?: StageResult }> {
    const matching = this.sorted(this.hooks.filter((h) => this.matches(h, stage)));

    // 1. void before — observe
    for (const h of matching) {
      if (h.kind === 'void' && h.phase === 'before') {
        try {
          await h.run(ctx);
        } catch (err) {
          this.log('warn', `void before hook threw: ${this.errMsg(err)}`);
        }
      }
    }

    // 2. modifying before — mutate ctx (return ignored)
    for (const h of matching) {
      if (h.kind === 'modifying' && h.phase === 'before') {
        try {
          await h.run(ctx, undefined);
        } catch (err) {
          this.log('warn', `modifying before hook threw: ${this.errMsg(err)}`);
        }
      }
    }

    // 3. claiming — first non-null StageResult wins
    for (const h of matching) {
      if (h.kind === 'claiming') {
        try {
          const claimed = await h.claim(ctx);
          if (claimed) return { claimed };
        } catch (err) {
          this.log('warn', `claiming hook threw: ${this.errMsg(err)}`);
        }
      }
    }

    return {};
  }

  /**
   * Run after-stage hooks. Returns the (possibly replaced) StageResult.
   */
  async runAfter(ctx: RunContext, stage: StageName, result: StageResult): Promise<StageResult> {
    const matching = this.sorted(this.hooks.filter((h) => this.matches(h, stage)));
    let current = result;

    // 1. void after — observe
    for (const h of matching) {
      if (h.kind === 'void' && h.phase === 'after') {
        try {
          await h.run(ctx);
        } catch (err) {
          this.log('warn', `void after hook threw: ${this.errMsg(err)}`);
        }
      }
    }

    // 2. modifying after — may replace result
    for (const h of matching) {
      if (h.kind === 'modifying' && h.phase === 'after') {
        try {
          const replaced = await h.run(ctx, current);
          if (replaced) current = replaced;
        } catch (err) {
          this.log('warn', `modifying after hook threw: ${this.errMsg(err)}`);
        }
      }
    }

    return current;
  }

  // ─── internal ─────────────────────────────────────────────────────────

  private matches(hook: AnyHook, stage: StageName): boolean {
    const s = hook.kind === 'claiming' ? hook.stage : hook.stage;
    return s === stage || s === '*';
  }

  /** Priority desc, ties broken by registration order (stable). */
  private sorted(hooks: AnyHook[]): AnyHook[] {
    return [...hooks].sort((a, b) => {
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pb !== pa) return pb - pa;
      return (this.order.get(a) ?? 0) - (this.order.get(b) ?? 0);
    });
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
