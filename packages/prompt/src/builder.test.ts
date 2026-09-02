import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildSystemPromptBundle, truncateBootstrap, applyBootstrapLimits } from './builder.js';
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
    expect(prompt).toContain('enter the active run Context working set');
    expect(prompt).toContain('Release only removes that atom from this run');
    expect(prompt).toContain('does not edit, invalidate or delete durable memory');
    expect(prompt).toContain("Turn the user's ideas into reliable, verified results");
    expect(prompt).toContain('Use progressive disclosure');
    expect(prompt).toContain('Resolve shorthand and omitted subjects from supplied recent conversation');
    expect(prompt).toContain('later explicit user corrections override earlier conflicting Assistant claims');
    expect(prompt).toContain('Never hide failure, partial completion, risk');
    expect(prompt).toContain('answer with hour and minute only');
    expect(prompt).toContain('Do not volunteer low-value timing or percentage details');
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

  it('respond mode keeps bounded memory awareness without execution policy', () => {
    const prompt = buildSystemPrompt({
      branding: DEFAULT_BRANDING,
      tools: [stubTool],
      workspace: '/tmp/ws',
      bootstrap: { 'USER.md': 'user preferences' },
      memoryRootIndex: `# Memory Tree Root Index\n${'branch-entry\n'.repeat(400)}`,
      mode: 'respond',
    });

    expect(prompt).toContain('Memory Tree Root Index');
    expect(prompt).toContain('root index truncated');
    expect(prompt).toContain('Registered in this run: read');
    expect(prompt).toContain('USER.md');
    expect(prompt).not.toContain('# Core Flow');
    expect(prompt).not.toContain('# Workspace');
    expect(prompt).not.toContain('# Safety');
    expect(prompt).not.toContain('root index -> branch index -> node/query expansion');
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

  it('exposes memory and each bootstrap file as independently accountable segments', () => {
    const input = {
      branding: DEFAULT_BRANDING,
      tools: [stubTool],
      workspace: '/tmp/ws',
      bootstrap: {
        'AGENTS.md': 'agent rules',
        'USER.md': 'user preferences',
      },
      memoryRootIndex: '# Memory Tree Root Index',
      mode: 'full' as const,
    };
    const bundle = buildSystemPromptBundle(input);

    expect(bundle.segments.map((segment) => segment.id)).toEqual(expect.arrayContaining([
      'memory-root-index',
      'bootstrap:AGENTS.md',
      'bootstrap:USER.md',
    ]));
    expect(bundle.segments.find((segment) => segment.id === 'memory-root-index')).toMatchObject({
      kind: 'memory_index',
      scope: 'global',
      required: true,
    });
    expect(bundle.segments.find((segment) => segment.id === 'bootstrap:AGENTS.md')).toMatchObject({
      kind: 'project_knowledge',
      scope: 'workspace',
      required: true,
    });
    expect(bundle.segments.find((segment) => segment.id === 'bootstrap:USER.md')).toMatchObject({
      kind: 'project_knowledge',
      scope: 'global',
      required: false,
    });
    expect(bundle.segments.map((segment) => segment.text).join('')).toBe(bundle.text);
    expect(bundle.text).toBe(buildSystemPrompt(input));
  });

  it('keeps the initial D2 atom selection below the prompt cache boundary', () => {
    const bundle = buildSystemPromptBundle({
      branding: DEFAULT_BRANDING,
      tools: [stubTool],
      workspace: '/tmp/ws',
      bootstrap: {},
      memoryRootIndex: '# Memory Tree Root Index',
      initialMemoryContext: '# Initially Selected Memory Atoms\n\n## [atom-a] T2\nRelevant fact.',
      mode: 'full',
    });
    const segment = bundle.segments.find((candidate) => candidate.id === 'initial-memory-selection');
    expect(segment).toMatchObject({
      kind: 'memory_fragment',
      scope: 'run',
      required: true,
      source: { kind: 'memory', id: 'initial-selection' },
    });
    const parts = splitAtBoundary(bundle.text);
    expect(parts.stable).not.toContain('Relevant fact.');
    expect(parts.volatile).toContain('Relevant fact.');
  });

  it('registers a versioned session summary as summary memory', () => {
    const bundle = buildSystemPromptBundle({
      branding: DEFAULT_BRANDING,
      tools: [],
      workspace: '/tmp/ws',
      bootstrap: {},
      sessionSummary: {
        version: 1,
        id: 'summary-1',
        collapsedCount: 40,
        summary: 'Earlier goals and decisions.',
        compactedAt: '2026-07-13T01:00:00.000Z',
        sourceStartMessageId: 'message-1',
        sourceEndMessageId: 'message-40',
        sourceStartAt: '2026-07-12T01:00:00.000Z',
        sourceEndAt: '2026-07-13T00:00:00.000Z',
      },
    });

    expect(bundle.segments.find((segment) => segment.id === 'summary-memory:summary-1')).toMatchObject({
      kind: 'summary_memory',
      scope: 'session',
      required: true,
      source: { kind: 'memory', id: 'summary-1' },
    });
    expect(bundle.text).toContain('Earlier goals and decisions.');
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
