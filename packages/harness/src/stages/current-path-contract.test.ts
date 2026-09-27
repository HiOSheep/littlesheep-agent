// HC-05: the constraints that keep the current execution path current.
//
// Two kinds of regression are cheap to reintroduce and expensive to notice, so they are asserted here
// instead of being left to review:
//
//   1. the retired execution system quietly coming back — a new run building a TaskBook/TaskExecution, a
//      persisted work policy choosing the second mode, or a live route naming a stage that no longer
//      exists. The compatibility readers may still *read* those values; nothing may create them.
//   2. the re-execution capability being declared somewhere it cannot be honoured. A warrant needs the
//      Runtime to know the operation's resources, which is why exactly the file tools declare it and an
//      opaque tool does not.
//
// The scan is over production sources only, and it names the symbols and fields it forbids rather than
// banning words: tests are allowed to build the retired shapes, because that is how compatibility readers
// stay exercised.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultHarness } from '../default-harness.js';
import { makeCtx, makeTool, createMockLlm, createMockSessionManager, createMockMemoryStore, textResponse, toolCallResponse } from '../tests/helpers.js';
import { textMessage } from '@littlesheep/types';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import type { AgentTool } from '@littlesheep/types';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const PACKAGE_ROOTS = ['packages/harness/src', 'packages/runner/src', 'packages/types/src'];

function productionSources(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(REPO, root), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
    files.push(join(entry.parentPath ?? root, entry.name).replace(`${REPO}\\`, '').replaceAll('\\', '/'));
  }
  return files;
}

const ALL_PRODUCTION_SOURCES = PACKAGE_ROOTS.flatMap(productionSources);

describe('the retired execution system cannot come back through the current path', () => {
  it('finds production sources to check', () => {
    expect(ALL_PRODUCTION_SOURCES.length).toBeGreaterThan(50);
    expect(ALL_PRODUCTION_SOURCES).toContain('packages/harness/src/stages/execute/main-loop.ts');
    expect(ALL_PRODUCTION_SOURCES).toContain('packages/runner/src/runner.ts');
  });

  it('never builds a retirement-era execution plan', () => {
    // `complexity` only exists on a TaskBook assessment, and the execution mode only on a work policy:
    // both are values an old record may carry and current code may read, never write.
    const offenders = ALL_PRODUCTION_SOURCES.filter((source) => {
      const text = readFileSync(join(REPO, source), 'utf8');
      return /\bcomplexity:\s*'(trivial|simple|standard|complex)'/u.test(text)
        || /executionMode:\s*'task_book'/u.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('never references the retired entry points or the deleted step helpers', () => {
    const retired = [
      'executeLegacyLoop',
      'createNextHarness',
      'resolveExecutionWorkPolicy',
      'canUseLeanWorkLoop',
      'installPartialReplan',
      'deriveReplanTargets',
      'canRecoverWithPartialReplan',
      'hasIncompleteTaskExecution',
    ];
    const offenders = ALL_PRODUCTION_SOURCES.filter((source) => {
      const text = readFileSync(join(REPO, source), 'utf8');
      return retired.some((symbol) => new RegExp(`\\b${symbol}\\b`, 'u').test(text));
    });
    expect(offenders).toEqual([]);
  });

  it('keeps the runtime task queue as the only way a retired stage could be routed to', () => {
    // A retired stage may be *read* from a checkpoint and normalized, never targeted by a live decision.
    const sources = ALL_PRODUCTION_SOURCES.filter((source) => source.includes('packages/harness/src'));
    const offenders = sources.filter((source) => {
      const text = readFileSync(join(REPO, source), 'utf8');
      return /next:\s*'(decide|evolve|capture)'/u.test(text);
    });
    expect(offenders).toEqual([]);
  });
});

describe('the re-execution capability is declared only where the Runtime can honour it', () => {
  const read = (relative: string) => readFileSync(join(REPO, relative), 'utf8');

  it('is declared by the file tools, which have resolved write resources', () => {
    expect(read('packages/tools/src/builtin/write.ts')).toContain('reRunnableAfterResourceChange: true');
    expect(read('packages/tools/src/builtin/edit.ts')).toContain('reRunnableAfterResourceChange: true');
  });

  it('is not declared by an opaque tool, whose scope cannot be proven', () => {
    const exec = read('packages/tools/src/builtin/exec.ts');
    expect(exec).not.toContain('reRunnableAfterResourceChange');
  });
});

describe('re-execution wiring end to end', () => {
  /** A tool the Runtime can scope: it declares a write resource and says a repeat can be a new operation. */
  function scopedTool(name: string, callIds: { id: string }): AgentTool {
    const tool = makeTool(name, { ok: true, output: 'done' });
    return {
      ...tool,
      reRunnableAfterResourceChange: true,
      execution: {
        concurrency: 'parallel',
        resources: () => [{ key: `fs:${join(REPO, 'package.json').toLowerCase()}`, mode: 'write' as const }],
      },
      async execute(input, ctx) {
        void callIds.id;
        return tool.execute(input, ctx);
      },
    };
  }

  it('runs the same call again once the run recorded a change to the same resource', async () => {
    const marker = { id: 'probe-1' };
    const tool = scopedTool('probe_mutate', marker);
    const llm = createMockLlm([
      toolCallResponse([{ id: 'probe-1', name: 'probe_mutate', args: { value: 'first' } }]),
      toolCallResponse([{ id: 'probe-2', name: 'probe_mutate', args: { value: 'second' } }]),
      toolCallResponse([{ id: 'probe-3', name: 'probe_mutate', args: { value: 'first' } }]),
      textResponse('done'),
    ]);
    const harness = createDefaultHarness({
      model: 'test',
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      llm,
      sessionManager: createMockSessionManager(),
      memoryStore: createMockMemoryStore(),
    });
    const ctx = makeCtx({
      inbound: textMessage('user', 'run the probe three times'),
      tools: [tool],
    });

    const result = await harness.run(ctx);

    expect(result.ok).toBe(true);
    // Three calls with the third repeating the first: the settled change in between is the warrant, so the
    // repeat is a new execution rather than the `repeated_call_blocked` refusal.
    expect(tool.calls.map((call) => (call.input as { value: string }).value)).toEqual(['first', 'second', 'first']);
    const effects = ctx.sideEffects ?? [];
    const firstKey = effects.find((effect) => effect.callId === 'probe-1')?.idempotencyKey;
    expect(firstKey).toBeDefined();
    expect(effects.filter((effect) => effect.idempotencyKey.startsWith(firstKey!))).toHaveLength(2);
    expect(effects.find((effect) => effect.idempotencyKey === `${firstKey}:retry1`)).toMatchObject({
      status: 'succeeded',
    });
    expect(ctx.toolResults?.filter((entry) => entry.ok === false)).toEqual([]);
  });
});
