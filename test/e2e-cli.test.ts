// e2e-cli.test.ts — spawn the built CLI binary, test --help/--version.
// Skipped if dist/ is not built (run `pnpm build` first).

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'packages', 'cli', 'dist', 'bin.js');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runBin(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [BIN, ...args], { cwd: process.cwd() });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on('data', (c) => stdout.push(c.toString()));
    child.stderr.on('data', (c) => stderr.push(c.toString()));
    child.on('close', (code) => resolve({ code, stdout: stdout.join(''), stderr: stderr.join('') }));
    child.on('error', (err) => resolve({ code: -1, stdout: '', stderr: err.message }));
  });
}

describe.skipIf(!existsSync(BIN))('e2e cli (requires pnpm build)', () => {
  it('--help exits 0 and prints usage', async () => {
    const { code, stdout } = await runBin(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('littlesheep');
  });

  it('--version exits 0 and prints "0.1.0"', async () => {
    const { code, stdout } = await runBin(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('0.1.0');
  });
});
