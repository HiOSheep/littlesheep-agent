import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InjectionTier, type MemoryWriteIntent } from '../types.js';
import { createMemoryV3ExperimentMarker } from '../memory-repository.js';
import { resolveMemoryWritePolicy } from './write-policy.js';
import { MemoryRepositoryV3Backend } from './v3-backend.js';

describe('Memory v3 write graph projection', () => {
  const directories: string[] = [];
  const backends: MemoryRepositoryV3Backend[] = [];

  afterEach(async () => {
    for (const backend of backends.splice(0)) backend.close();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  it('activates a user-resolved replacement only after its Atom references the proposed relation', async () => {
    const backend = await openBackend('replacement');
    const old = await backend.write(userIntent({
      id: 'old-memory-intent',
      summary: 'Use the old memory injection rule',
      content: 'The old rule injects every matching memory candidate.',
      retrievalKeys: ['old memory injection rule'],
      statementKind: 'instruction',
      entityHints: [{ stableKey: 'rule:old-injection', type: 'rule', label: 'Old injection rule' }],
    }));
    const replacement = await backend.write(userIntent({
      id: 'replacement-memory-intent',
      summary: 'Replace the old injection rule',
      content: 'Use the bounded relevant-Atom rule instead of the old injection rule.',
      retrievalKeys: ['bounded atom injection', 'old memory injection rule'],
      statementKind: 'decision',
      entityHints: [
        { stableKey: 'rule:old-injection', type: 'rule', label: 'Old injection rule' },
        { stableKey: 'rule:bounded-injection', type: 'rule', label: 'Bounded Atom injection rule' },
      ],
      relationHints: [{ fromKey: 'rule:bounded-injection', toKey: 'rule:old-injection', type: 'replaces' }],
    }));

    const atom = await backend.atomStore.read(replacement.node!.id);
    expect(atom?.relationRefs).toHaveLength(1);
    const relation = await backend.graphStore.getRelation(atom!.relationRefs[0]!);
    expect(relation).toMatchObject({
      type: 'replaces',
      status: 'active',
      resolutionStatus: 'resolved',
      authorityScope: { kind: 'user-self', scope: 'global' },
    });
    expect(backend.catalog.relationReferenceBlockers(relation!.id).atomIds).toContain(replacement.node!.id);

    const oldEntry = backend.catalog.getAtom(old.node!.id)!;
    expect(backend.catalog.listRelationRoutingCandidates([old.node!.id], {
      branch: 'long-term',
      limit: 10,
    }, '2026-07-17T07:30:00.000Z')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entry: expect.objectContaining({ atomId: replacement.node!.id }),
        relationType: 'replaces',
        direction: 'inbound',
      }),
    ]));
    vi.spyOn(backend.catalog, 'searchFts').mockReturnValue([{ entry: oldEntry, score: 1, matchReason: 'fts' }]);
    vi.spyOn(backend.catalog, 'listAtoms').mockReturnValue([oldEntry]);
    const candidates = await backend.indexMemory({
      branch: 'long-term',
      scopes: [{ scope: 'global' }],
      query: 'Use the old memory injection rule',
      limit: 10,
      now: '2026-07-17T07:30:00.000Z',
    });
    expect(candidates.find((candidate) => candidate.atom.id === replacement.node!.id)).toMatchObject({
      retrievalPath: 'relation',
      envelope: { relationRoute: { relationType: 'replaces', direction: 'inbound' } },
    });
  });

  it('keeps an unverified suggestion proposed and unavailable to automatic relation routing', async () => {
    const backend = await openBackend('suggestion');
    const result = await backend.write(agentSuggestionIntent());
    const atom = await backend.atomStore.read(result.node!.id);
    const relation = await backend.graphStore.getRelation(atom!.relationRefs[0]!);

    expect(relation).toMatchObject({
      type: 'depends-on',
      status: 'proposed',
      resolutionStatus: 'proposed',
      confidence: 0.35,
      authorityScope: { kind: 'none' },
    });
    expect(backend.catalog.listRelationRoutingCandidates([atom!.id], {
      branch: 'project',
      limit: 10,
    }, '2026-07-17T07:30:00.000Z')).toEqual([]);
  });

  it('leaves a relation proposed when Atom commit fails and activates it on a successful retry', async () => {
    const backend = await openBackend('commit-failure');
    const intent = userIntent({
      id: 'recoverable-relation-intent',
      summary: 'Adopt a bounded memory dependency',
      content: 'The current memory rule depends on the bounded task relevance gate.',
      retrievalKeys: ['bounded memory dependency'],
      statementKind: 'decision',
      entityHints: [
        { stableKey: 'rule:current', type: 'rule', label: 'Current memory rule' },
        { stableKey: 'rule:task-relevance', type: 'rule', label: 'Task relevance gate' },
      ],
      relationHints: [{ fromKey: 'rule:current', toKey: 'rule:task-relevance', type: 'depends-on' }],
    });
    const apply = vi.spyOn(backend.coordinator, 'apply').mockRejectedValueOnce(new Error('simulated atom commit failure'));

    await expect(backend.write(intent)).rejects.toThrow('simulated atom commit failure');
    const [proposed] = await backend.graphStore.listRelations({ status: 'proposed', limit: 10 });
    expect(proposed).toBeTruthy();
    expect(backend.catalog.relationReferenceBlockers(proposed!.id).atomIds).toEqual([]);

    apply.mockRestore();
    const retried = await backend.write(intent);
    expect(retried.decision).toBe('created');
    expect(await backend.graphStore.getRelation(proposed!.id)).toMatchObject({ status: 'active' });
  });

  it('recovers a committed Atom whose eligible relation activation was interrupted', async () => {
    let backend = await openBackend('startup-recovery');
    const result = await backend.write(userIntent({
      id: 'startup-relation-intent',
      summary: 'Use the verified dependency',
      content: 'The active memory policy depends on the relevance gate.',
      retrievalKeys: ['verified dependency'],
      statementKind: 'decision',
      entityHints: [
        { stableKey: 'policy:active-memory', type: 'rule', label: 'Active memory policy' },
        { stableKey: 'gate:relevance', type: 'rule', label: 'Relevance gate' },
      ],
      relationHints: [{ fromKey: 'policy:active-memory', toKey: 'gate:relevance', type: 'depends-on' }],
    }));
    const atom = await backend.atomStore.read(result.node!.id);
    const relation = await backend.graphStore.getRelation(atom!.relationRefs[0]!);
    await backend.graphStore.upsertRelation({
      ...relation!,
      status: 'proposed',
      revision: relation!.revision + 1,
      updatedAt: '2026-07-17T07:31:00.000Z',
    });
    backend.close();
    backends.splice(backends.indexOf(backend), 1);

    backend = createBackend(directories.at(-1)!);
    backends.push(backend);
    await backend.initialize();
    expect(await backend.graphStore.getRelation(relation!.id)).toMatchObject({
      status: 'active',
      resolutionStatus: 'resolved',
    });
  });

  it('activates a resolved conflict without treating similarity as evidence', async () => {
    const backend = await openBackend('conflict');
    const first = await backend.write(userIntent({
      id: 'conflict-first-intent',
      summary: 'Keep all matching memory candidates',
      content: 'The first policy keeps every matching memory candidate.',
      retrievalKeys: ['keep all memory candidates'],
      statementKind: 'instruction',
      entityHints: [{ stableKey: 'policy:keep-all', type: 'rule', label: 'Keep-all policy' }],
    }));
    const second = await backend.write(userIntent({
      id: 'conflict-second-intent',
      summary: 'Use a bounded memory working set',
      content: 'The bounded working-set policy conflicts with keeping every candidate.',
      retrievalKeys: ['bounded memory working set', 'keep all memory candidates'],
      statementKind: 'decision',
      entityHints: [
        { stableKey: 'policy:keep-all', type: 'rule', label: 'Keep-all policy' },
        { stableKey: 'policy:bounded-set', type: 'rule', label: 'Bounded working-set policy' },
      ],
      relationHints: [
        { fromKey: 'policy:bounded-set', toKey: 'policy:keep-all', type: 'conflicts-with' },
        { fromKey: 'policy:bounded-set', toKey: 'policy:keep-all', type: 'similar-to' },
      ],
    }));
    const atom = await backend.atomStore.read(second.node!.id);
    const relations = await Promise.all(atom!.relationRefs.map((id) => backend.graphStore.getRelation(id)));
    expect(relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'conflicts-with', status: 'active', resolutionStatus: 'resolved' }),
      expect.objectContaining({ type: 'similar-to', status: 'active', resolutionStatus: 'resolved' }),
    ]));
    const routes = backend.catalog.listRelationRoutingCandidates([first.node!.id], {
      branch: 'long-term',
      limit: 10,
    }, '2026-07-17T07:30:00.000Z');
    expect(routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ entry: expect.objectContaining({ atomId: second.node!.id }), relationType: 'conflicts-with' }),
    ]));
    expect(routes.some((route) => route.relationType === 'similar-to')).toBe(false);
  });

  it('rejects explicit graph references that cross the write scope boundary', async () => {
    const backend = await openBackend('scope-boundary');
    const global = await backend.write(userIntent({
      id: 'global-entity-intent',
      summary: 'Global memory boundary',
      content: 'This global rule has a global entity.',
      retrievalKeys: ['global memory boundary'],
      statementKind: 'instruction',
      entityHints: [{ stableKey: 'rule:global', type: 'rule', label: 'Global rule' }],
    }));
    const globalAtom = await backend.atomStore.read(global.node!.id);

    await expect(backend.write({
      ...projectToolIntent(),
      epistemic: {
        ...projectToolIntent().epistemic!,
        entityRefs: [globalAtom!.entityRefs.find((id) => id.includes('memory-entity:rule:'))!],
      },
    })).rejects.toThrow(/crosses the write scope boundary/u);
  });

  async function openBackend(label: string): Promise<MemoryRepositoryV3Backend> {
    const dataDir = await mkdtemp(join(tmpdir(), `ls-memory-v3-write-graph-${label}-`));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const backend = createBackend(dataDir);
    backends.push(backend);
    await backend.initialize();
    return backend;
  }
});

function createBackend(dataDir: string): MemoryRepositoryV3Backend {
  return new MemoryRepositoryV3Backend({ dataDir, policy: resolveMemoryWritePolicy() });
}

function userIntent(input: {
  id: string;
  summary: string;
  content: string;
  retrievalKeys: string[];
  statementKind: 'instruction' | 'decision';
  entityHints: NonNullable<NonNullable<MemoryWriteIntent['epistemic']>['entityHints']>;
  relationHints?: NonNullable<NonNullable<MemoryWriteIntent['epistemic']>['relationHints']>;
}): MemoryWriteIntent {
  return {
    id: input.id,
    branch: 'long-term',
    parentNodeId: 'long-term:root',
    scope: 'global',
    tier: InjectionTier.T2_RELEVANT,
    summary: input.summary,
    content: input.content,
    retrievalKeys: input.retrievalKeys,
    sourceRunId: `run:${input.id}`,
    sourceStage: 'evolve',
    sourceRefs: [`conversation-source:${input.id}:user-message:1`],
    importance: 0.9,
    confidence: 0.95,
    reason: 'The user explicitly established this scoped memory rule.',
    epistemic: {
      domain: 'user',
      statementKind: input.statementKind,
      epistemicStatus: 'reported',
      authorityScope: { kind: 'user-self', scope: 'global', topics: ['memory-v3'] },
      assertedBy: { kind: 'user', id: 'local-user' },
      entityHints: input.entityHints,
      relationHints: input.relationHints,
    },
  };
}

function agentSuggestionIntent(): MemoryWriteIntent {
  return {
    branch: 'project',
    parentNodeId: 'project:root',
    scope: 'workspace',
    scopeKey: 'D:/repo',
    tier: InjectionTier.T2_RELEVANT,
    summary: 'Possible memory dependency',
    content: 'The planner may depend on a broad historical context.',
    retrievalKeys: ['possible memory dependency'],
    sourceRunId: 'run-agent-suggestion',
    sourceStage: 'evolve',
    sourceRefs: ['conversation-source:run-agent-suggestion:assistant-reply:1'],
    importance: 0.7,
    confidence: 0.7,
    reason: 'An unverified model suggestion for later review.',
    epistemic: {
      domain: 'project',
      statementKind: 'suggestion',
      epistemicStatus: 'unverified',
      authorityScope: { kind: 'none', scope: 'workspace', scopeKey: 'D:/repo', topics: [] },
      assertedBy: { kind: 'agent', id: 'littlesheep' },
      entityHints: [
        { stableKey: 'component:planner', type: 'concept', label: 'Planner' },
        { stableKey: 'context:broad-history', type: 'concept', label: 'Broad historical context' },
      ],
      relationHints: [{ fromKey: 'component:planner', toKey: 'context:broad-history', type: 'depends-on' }],
    },
  };
}

function projectToolIntent(): MemoryWriteIntent {
  return {
    branch: 'project',
    parentNodeId: 'project:root',
    scope: 'workspace',
    scopeKey: 'D:/repo',
    tier: InjectionTier.T2_RELEVANT,
    summary: 'Workspace-scoped tool fact',
    content: 'The workspace uses a scoped tool fact.',
    retrievalKeys: ['workspace scoped tool fact'],
    sourceRunId: 'run-workspace-tool',
    sourceStage: 'tool',
    sourceRefs: ['conversation-source:run-workspace-tool:assistant-reply:1'],
    evidenceRefs: ['run:run-workspace-tool:tool:inspect:succeeded', 'run:run-workspace-tool:verification:1:pass'],
    importance: 0.8,
    confidence: 0.9,
    reason: 'Verified by a successful workspace tool call.',
    epistemic: {
      domain: 'project',
      statementKind: 'factual-claim',
      epistemicStatus: 'corroborated',
      authorityScope: { kind: 'tool-evidence', scope: 'workspace', scopeKey: 'D:/repo', topics: [] },
      assertedBy: { kind: 'tool', id: 'inspect' },
    },
  };
}
