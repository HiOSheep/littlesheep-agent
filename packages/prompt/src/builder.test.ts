import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, truncateBootstrap, applyBootstrapLimits } from './builder.js';
import { splitAtBoundary, CACHE_BOUNDARY_MARKER } from './cache-boundary.js';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import type { AgentTool } from '@littlesheep/types';

const stubTool: AgentTool = {
  name: 'read',
  description: 'Read a file',
  inputSchema: { parse: (x: unknown) => x },
  execute: async () => ({ callId: '', ok: true, output: '' }),
};

describe('buildSystemPrompt', () => {
  it('full mode includes all sections + cache boundary', () => {
    const prompt = buildSystemPrompt({
      branding: DEFAULT_BRANDING,
      tools: [stubTool],
      workspace: '/tmp/ws',
      bootstrap: { 'AGENTS.md': 'test instructions' },
      memoryRootIndex: '# Memory Tree Root Index\n- `daily`: dated details',
      mode: 'full',
    });
    expect(prompt).toContain('LittleSheep');
    expect(prompt).toContain('Core Flow');
    expect(prompt).toContain('read');
    expect(prompt).toContain(CACHE_BOUNDARY_MARKER);
    expect(prompt).toContain('AGENTS.md');
    expect(prompt).toContain('Memory Tree Root Index');
    expect(prompt).toContain('root index -> branch index -> node/query expansion');
    expect(prompt).toContain('Never search across the whole tree by default');
    expect(prompt).toContain('Semantic/vector recall is a last-resort candidate source');
    const parts = splitAtBoundary(prompt);
    expect(parts.stable).toContain('Memory Tree Root Index');
    expect(parts.volatile).not.toContain('Memory Tree Root Index');
  });

  it('minimal mode omits Core Flow section heading and prelude', () => {
    const prompt = buildSystemPrompt({
      branding: DEFAULT_BRANDING,
      tools: [stubTool],
      workspace: '/tmp/ws',
      bootstrap: { 'AGENTS.md': 'test' },
      mode: 'minimal',
    });
    expect(prompt).toContain('LittleSheep');
    // The Core Flow SECTION (with its heading) is omitted in minimal mode.
    // The identity line may mention "Core Flow" in prose, so check the heading.
    expect(prompt).not.toContain('# Core Flow (hard control flow)');
    expect(prompt).not.toContain(CACHE_BOUNDARY_MARKER);
    expect(prompt).not.toContain('Project Context');
  });

  it('none mode returns only identity line', () => {
    const prompt = buildSystemPrompt({
      branding: DEFAULT_BRANDING,
      tools: [],
      workspace: '/tmp',
      bootstrap: {},
      mode: 'none',
    });
    expect(prompt).toBe('You are LittleSheep.');
  });

  it('splitAtBoundary correctly separates stable/volatile', () => {
    const prompt = `stable part\n\n${CACHE_BOUNDARY_MARKER}\n\nvolatile part`;
    const { stable, volatile } = splitAtBoundary(prompt);
    expect(stable).toBe('stable part');
    expect(volatile).toBe('volatile part');
  });
});

describe('truncateBootstrap', () => {
  it('returns content unchanged when under limit', () => {
    const { text, truncated } = truncateBootstrap('short', 100);
    expect(text).toBe('short');
    expect(truncated).toBe(false);
  });

  it('truncates with marker when over limit', () => {
    const long = 'x'.repeat(200);
    const { text, truncated } = truncateBootstrap(long, 50);
    expect(truncated).toBe(true);
    expect(text).toContain('truncated');
    expect(text.length).toBeLessThan(long.length);
  });
});

describe('applyBootstrapLimits', () => {
  it('respects per-file and total limits', () => {
    const bootstrap = {
      'AGENTS.md': 'a'.repeat(100),
      'SOUL.md': 'b'.repeat(100),
    };
    const result = applyBootstrapLimits(bootstrap, 50, 80);
    const agentsResult = result['AGENTS.md'];
    expect(agentsResult).toBeDefined();
    expect(agentsResult!.length).toBeLessThanOrEqual(80);
    expect(result['SOUL.md']).toContain('skipped');
  });
});
