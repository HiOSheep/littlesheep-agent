// @littlesheep/cli — args.test.ts
// Pure-function tests for parseArgs. No mocks needed.

import { describe, it, expect } from 'vitest';
import { parseArgs, USAGE, VERSION } from './args.js';

describe('parseArgs', () => {
  it('empty argv → all defaults', () => {
    const out = parseArgs([]);
    expect(out.help).toBe(false);
    expect(out.version).toBe(false);
    expect(out.session).toBeUndefined();
    expect(out.model).toBeUndefined();
    expect(out.text).toBeUndefined();
    expect(out.unknown).toEqual([]);
  });

  it('-h sets help', () => {
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('--help sets help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('-v sets version', () => {
    expect(parseArgs(['-v']).version).toBe(true);
  });

  it('--version sets version', () => {
    expect(parseArgs(['--version']).version).toBe(true);
  });

  it('-s <id> sets session', () => {
    expect(parseArgs(['-s', 'abc']).session).toBe('abc');
  });

  it('--session <id> sets session', () => {
    expect(parseArgs(['--session', 'xyz']).session).toBe('xyz');
  });

  it('--session=<id> sets session', () => {
    expect(parseArgs(['--session=sid123']).session).toBe('sid123');
  });

  it('-m <ref> sets model', () => {
    expect(parseArgs(['-m', 'openai/gpt-4o']).model).toBe('openai/gpt-4o');
  });

  it('--model <ref> sets model', () => {
    expect(parseArgs(['--model', 'openai/gpt-4o']).model).toBe('openai/gpt-4o');
  });

  it('--model=<ref> sets model', () => {
    expect(parseArgs(['--model=openai/gpt-4o']).model).toBe('openai/gpt-4o');
  });

  it('positional arg sets text', () => {
    expect(parseArgs(['hello']).text).toBe('hello');
  });

  it('unknown flags go to unknown[]', () => {
    const out = parseArgs(['--bogus', '--weird']);
    expect(out.unknown).toEqual(['--bogus', '--weird']);
  });

  it('recognizes the retired memory archive command without treating it as chat input', () => {
    const out = parseArgs(['memory', 'archive', '--force']);
    expect(out.retiredCommand).toBe('memory archive');
    expect(out.text).toBeUndefined();
    expect(out.unknown).toEqual([]);
  });

  it('USAGE contains "Usage:" and "littlesheep"', () => {
    expect(USAGE).toContain('Usage:');
    expect(USAGE).toContain('littlesheep');
    expect(USAGE).not.toContain('memory archive');
  });

  it('VERSION === "0.1.0"', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
