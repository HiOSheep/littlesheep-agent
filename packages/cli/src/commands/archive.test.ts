// @littlesheep/cli — commands/archive.test.ts
// Covers parseArchiveFlags (pure) + runArchive (integration: real MemoryStore +
// real VectorStore in tmpdir, mock LlmClient). CLI `runArchive` constructs the
// VectorStore internally and uses the real `now`, so expired dates are computed
// relative to today to keep the tests valid whenever they run.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '@littlesheep/memory-core';
import type { LlmClient, ChatResponse, EmbedRequest, EmbedResponse } from '@littlesheep/llm';
import { parseArchiveFlags, runArchive } from './archive.js';

// ─── Mocks ──────────────────────────────────────────────────────────────

/** Mock LlmClient: chat returns a fixed JSON string (for distillation);
 * embed returns deterministic char-hash vectors (real VectorStore calls embed
 * on insert). `dims` defaults low for speed but respects req.dimensions. */
function mockLlm(jsonResponse: string): LlmClient {
  const embed = vi.fn(async (req: EmbedRequest): Promise<EmbedResponse> => {
    const dims = req.dimensions ?? 8;
    const input = Array.isArray(req.input) ? req.input : [req.input];
    const embeddings = input.map((text) => {
      const vec = new Array(dims).fill(0);
      for (let i = 0; i < text.length; i++) vec[i % dims] += text.charCodeAt(i) / 1000;
      return vec;
    });
    return { embeddings, model: req.model, usage: { promptTokens: 0 } };
  });
  const chat = vi.fn(async () => ({
    content: jsonResponse,
    toolCalls: [],
    finishReason: 'stop',
  } as ChatResponse));
  return { chat, chatStream: vi.fn(), embed } as unknown as LlmClient;
}

/** Mock LlmClient whose chat rejects (simulates distillation API failure). */
function mockLlmRejects(err: Error): LlmClient {
  const embed = vi.fn(async (req: EmbedRequest): Promise<EmbedResponse> => {
    const dims = req.dimensions ?? 8;
    return {
      embeddings: [new Array(dims).fill(0)],
      model: req.model,
      usage: { promptTokens: 0 },
    };
  });
  const chat = vi.fn(async () => Promise.reject(err));
  return { chat, chatStream: vi.fn(), embed } as unknown as LlmClient;
}

const DISTILLED_JSON = JSON.stringify({
  summary: 'Focused on event-driven architecture and SQLite vector search.',
  keyEvents: ['Implemented vector store', 'Added archive logic'],
  topics: ['architecture', 'vector-search'],
});

/** YYYY-MM-DD that is `days` before today (matches archive.ts dateMinusDays). */
function dateMinusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// ─── Setup ──────────────────────────────────────────────────────────────

let dataDir: string;
let origExitCode: typeof process.exitCode;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ls-cli-arch-'));
  origExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = origExitCode;
  rmSync(dataDir, { recursive: true, force: true });
});

// ─── parseArchiveFlags ──────────────────────────────────────────────────

describe('parseArchiveFlags', () => {
  it('--dry-run sets dryRun', () => {
    expect(parseArchiveFlags(['--dry-run']).dryRun).toBe(true);
  });

  it('--force sets force', () => {
    expect(parseArchiveFlags(['--force']).force).toBe(true);
  });

  it('--model <ref> (space form)', () => {
    expect(parseArchiveFlags(['--model', 'openai/gpt-4o']).model).toBe('openai/gpt-4o');
  });

  it('--model=<ref> (equals form)', () => {
    expect(parseArchiveFlags(['--model=openai/gpt-4o']).model).toBe('openai/gpt-4o');
  });

  it('no flags → all undefined', () => {
    const f = parseArchiveFlags([]);
    expect(f.dryRun).toBeUndefined();
    expect(f.force).toBeUndefined();
    expect(f.model).toBeUndefined();
  });
});

// ─── runArchive ─────────────────────────────────────────────────────────

describe('runArchive', () => {
  it('archives expired daily + outputs summary', async () => {
    const memoryStore = new MemoryStore({ rootDir: dataDir });
    const archiveDir = join(dataDir, 'archive');
    const vectorsDir = join(dataDir, 'vectors');
    // Two expired dailies (>30 days old).
    await memoryStore.appendDaily(dateMinusDays(45), 'learned about sqlite');
    await memoryStore.appendDaily(dateMinusDays(50), 'built vector store');

    const out = vi.fn();
    const err = vi.fn();
    await runArchive({
      flags: {},
      llm: mockLlm(DISTILLED_JSON),
      model: 'test',
      memoryStore,
      archiveDir,
      vectorsDir,
      out,
      err,
    });

    const written = out.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('Archived 2 daily files');
    // Daily files moved into archive/YYYY/MM/DD.md.
    expect(existsSync(archiveDir)).toBe(true);
    const yearDirs = readdirSync(archiveDir);
    expect(yearDirs.length).toBeGreaterThan(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('--dry-run outputs DRY RUN prefix + no files moved', async () => {
    const memoryStore = new MemoryStore({ rootDir: dataDir });
    const archiveDir = join(dataDir, 'archive');
    const vectorsDir = join(dataDir, 'vectors');
    await memoryStore.appendDaily(dateMinusDays(45), 'should not be archived');

    const out = vi.fn();
    const err = vi.fn();
    await runArchive({
      flags: { dryRun: true },
      llm: mockLlm(DISTILLED_JSON),
      model: 'test',
      memoryStore,
      archiveDir,
      vectorsDir,
      out,
      err,
    });

    const written = out.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('DRY RUN');
    // No files moved — archive dir was never created.
    expect(existsSync(archiveDir)).toBe(false);
  });

  it('no expired dates → "Nothing to archive"', async () => {
    const memoryStore = new MemoryStore({ rootDir: dataDir });
    const archiveDir = join(dataDir, 'archive');
    const vectorsDir = join(dataDir, 'vectors');
    // A recent daily within the 30-day window.
    await memoryStore.appendDaily(dateMinusDays(5), 'recent work');

    const out = vi.fn();
    const err = vi.fn();
    await runArchive({
      flags: {},
      llm: mockLlm(DISTILLED_JSON),
      model: 'test',
      memoryStore,
      archiveDir,
      vectorsDir,
      out,
      err,
    });

    const written = out.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('Nothing to archive');
    expect(process.exitCode).toBeUndefined();
  });

  it('LLM failure → exitCode 1 + stderr', async () => {
    const memoryStore = new MemoryStore({ rootDir: dataDir });
    const archiveDir = join(dataDir, 'archive');
    const vectorsDir = join(dataDir, 'vectors');
    // An expired daily triggers the move + distillation; the rejecting chat
    // makes distillMonth throw, which propagates out of archiveOldMemories.
    await memoryStore.appendDaily(dateMinusDays(45), 'some content');

    const out = vi.fn();
    const err = vi.fn();
    await runArchive({
      flags: {},
      llm: mockLlmRejects(new Error('api down')),
      model: 'test',
      memoryStore,
      archiveDir,
      vectorsDir,
      out,
      err,
    });

    expect(process.exitCode).toBe(1);
    const errWritten = err.mock.calls.map((c) => String(c[0])).join('');
    expect(errWritten).toContain('archive failed');
    expect(errWritten).toContain('api down');
  });
});
