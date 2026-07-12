// @littlesheep/cli — repl.ts
// Interactive REPL: readline loop → runner.run → print reply.
// Uses a single readline interface (no competing stdin from interactiveApprove).
// Approvals are routed through rl.question on the same interface.

import { createInterface } from 'node:readline';
import type { AgentRunner, RunnerResult } from '@littlesheep/runner';
import type { BrandingConfig } from '@littlesheep/branding';
import type { SessionId } from '@littlesheep/types';

export interface ReplOptions {
  runner: AgentRunner;
  branding: BrandingConfig;
  sessionId?: SessionId;
  approve?: (action: string, detail?: unknown) => Promise<boolean>;
  /** Override stdin (tests). Default: process.stdin. */
  input?: NodeJS.ReadableStream;
  /** Override stdout (tests). Default: process.stdout. */
  output?: NodeJS.WritableStream;
}

/** Start the REPL. Resolves when stdin closes (Ctrl+D) or user exits via Ctrl+C twice. */
export async function startRepl(opts: ReplOptions): Promise<void> {
  const rl = createInterface({
    input: opts.input ?? process.stdin,
    output: opts.output ?? process.stdout,
  });
  const out = opts.output ?? process.stdout;
  let sessionId: SessionId | undefined = opts.sessionId;
  let controller: AbortController | undefined;

  // Approve via the same readline interface (no second interface on stdin).
  const approve = opts.approve ?? ((action: string, detail?: unknown) =>
    new Promise<boolean>((resolve) => {
      const detailStr = detail ? ` ${JSON.stringify(detail)}` : '';
      rl.question(`Approve ${action}?${detailStr} [y/N] `, (ans) => {
        const ok = ans.trim().toLowerCase() === 'y' || ans.trim().toLowerCase() === 'yes';
        resolve(ok);
      });
    }));

  // Banner.
  out.write(`${opts.branding.emoji} ${opts.branding.name} — ${opts.branding.tagline}\n`);
  out.write('Type your message. Ctrl+C aborts the current run; Ctrl+C again to exit.\n');
  rl.setPrompt(`${opts.branding.cliName}> `);
  rl.prompt();

  // Ctrl+C: abort in-flight run, or exit if idle.
  rl.on('SIGINT', () => {
    if (controller) {
      controller.abort();
      out.write('\n[aborted]\n');
    } else {
      out.write('\n');
      rl.close();
    }
  });

  // Main loop: async iterator naturally serializes runs (no concurrent 'line').
  for await (const line of rl) {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      continue;
    }
    controller = new AbortController();
    try {
      const result: RunnerResult = await opts.runner.run({
        sessionId,
        text,
        signal: controller.signal,
        approve,
        origin: 'cli',
      });
      sessionId = result.sessionId;
      out.write(`${result.reply || '(no reply)'}\n`);
      if (result.status === 'error') {
        out.write(`[error] ${result.error ?? 'unknown'}\n`);
      }
    } catch (err) {
      out.write(`[error] ${(err as Error).message}\n`);
    } finally {
      controller = undefined;
      rl.prompt();
    }
  }
}
