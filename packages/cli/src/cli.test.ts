// @littlesheep/cli — cli.test.ts
// Auto-mocks @littlesheep/runner to test runCli orchestration without real infra.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Auto-mock the runner module (all exports become vi.fn()).
vi.mock('@littlesheep/runner');

// Import AFTER vi.mock so the mock takes effect.
import { runCli } from './index.js';
import { createRunner } from '@littlesheep/runner';
import { asSessionId } from '@littlesheep/types';
import type { RunnerResult } from '@littlesheep/runner';

// Stable mock functions for the runner object's methods.
const mockRun = vi.fn();
const mockShutdown = vi.fn();

// Helper: stabilize the spy return type (vi.spyOn has many overloads; directly
// annotating with ReturnType<typeof vi.spyOn> picks the wrong overload).
function spyWrite(stream: NodeJS.WriteStream) {
  return vi.spyOn(stream, 'write');
}

let dataDir: string;
let origExitCode: typeof process.exitCode;
let stdoutSpy: ReturnType<typeof spyWrite>;
let stderrSpy: ReturnType<typeof spyWrite>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ls-cli-'));
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  process.env.OPENAI_API_KEY = 'test-key';
  // Isolate from project-root littlesheep.config.json: point LITTLESHEEP_CONFIG
  // to an empty-providers config in the temp dir so the loader doesn't walk up
  // from cwd and pick up the dev config (which only has the deepseek provider).
  const configPath = join(dataDir, 'config.json');
  writeFileSync(configPath, '{"providers":[]}', 'utf8');
  process.env.LITTLESHEEP_CONFIG = configPath;
  origExitCode = process.exitCode;
  process.exitCode = undefined;

  // Reset + re-set runner mock before each test.
  vi.mocked(createRunner).mockReset();
  vi.mocked(createRunner).mockResolvedValue({
    run: mockRun,
    runStream: mockRun,
    replay: vi.fn().mockResolvedValue(null),
    runtimeEvents: {
      append: () => ({ kind: 'rejected', reason: 'run-not-active', message: 'mock runner' }),
      summary: () => null,
    },
    shutdown: mockShutdown,
    state: { sessionId: undefined, model: 'openai/gpt-4o' },
    sessionManager: {} as never,
    infra: {} as never,
    model: 'openai/gpt-4o',
  });

  mockRun.mockReset();
  mockShutdown.mockReset();
  mockRun.mockResolvedValue({
    runId: 'r1',
    sessionId: asSessionId('s1'),
    status: 'ok',
    reply: 'mocked reply',
    messages: [],
    trace: [],
    durationMs: 0,
  } as RunnerResult);

  stdoutSpy = spyWrite(process.stdout);
  stderrSpy = spyWrite(process.stderr);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LITTLESHEEP_DATA_DIR;
  delete process.env.LITTLESHEEP_CONFIG;
  delete process.env.OPENAI_API_KEY;
  process.exitCode = origExitCode;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('runCli', () => {
  it('--help prints usage and does not invoke runner', async () => {
    await runCli(['--help']);
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('Usage:');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('--version prints "0.1.0" and does not invoke runner', async () => {
    await runCli(['--version']);
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written.trim()).toBe('0.1.0');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('positional text calls run with text + prints reply + shuts down', async () => {
    await runCli(['hello']);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun.mock.calls[0]![0]).toMatchObject({ text: 'hello', origin: 'cli' });
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('mocked reply');
    expect(mockShutdown).toHaveBeenCalledTimes(1);
  });

  it('--model passes model to createRunner and text to run', async () => {
    await runCli(['--model', 'openai/gpt-4o', 'hi']);
    expect(vi.mocked(createRunner)).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'openai/gpt-4o' }),
    );
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun.mock.calls[0]![0]).toMatchObject({ text: 'hi' });
  });

  it('unknown flag sets exitCode=2 and prints to stderr', async () => {
    await runCli(['--bogus']);
    expect(process.exitCode).toBe(2);
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('Unknown flags');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('retires memory archive before loading config, providers, or mutating user data', async () => {
    const configPath = join(dataDir, 'config.json');
    const invalidConfig = '{ this is intentionally invalid';
    writeFileSync(configPath, invalidConfig, 'utf8');
    const beforeEntries = readdirSync(dataDir).sort();

    await runCli(['memory', 'archive', '--force']);

    expect(process.exitCode).toBe(2);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('memory archive');
    expect(mockRun).not.toHaveBeenCalled();
    expect(vi.mocked(createRunner)).not.toHaveBeenCalled();
    expect(readdirSync(dataDir).sort()).toEqual(beforeEntries);
    expect(readFileSync(configPath, 'utf8')).toBe(invalidConfig);
  });
});
