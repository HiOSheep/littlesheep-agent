import { describe, expect, it, vi } from 'vitest';
import type { MemoryAtom } from './v3/contracts.js';
import { memoryAtomContentHash } from './v3/atom-store.js';
import { makeStoredAtom } from './v3/test-fixtures.js';
import type {
  MemoryAtomManagementRequest,
  MemoryAtomManagementResult,
  MemoryAtomRevisionPatch,
  MemoryRepositoryManagementFacade,
} from './memory-repository/management.js';
import {
  MemoryAtomRevisionService,
  type MemoryAtomRevisionProposal,
} from './memory-revision.js';

describe('MemoryAtomRevisionService', () => {
  it('commits one same-claim refinement and recognizes an identical retry as a noop', async () => {
    const current = atom();
    const atoms = new Map([[current.id, current]]);
    const invalidate = vi.fn(async () => undefined);
    const service = new MemoryAtomRevisionService({
      management: fakeManagement(atoms),
      invalidate,
    });
    const proposal = revisionProposal();

    const [first] = await service.revise([proposal]);
    const [retried] = await service.revise([proposal]);

    expect(first).toMatchObject({
      status: 'committed',
      committed: true,
      previousRevision: 1,
      revision: 2,
    });
    expect(atoms.get(current.id)).toMatchObject({
      revision: 2,
      title: proposal.replacement.title,
      summary: proposal.replacement.summary,
      content: proposal.replacement.content,
      retrievalKeys: proposal.replacement.retrievalKeys,
      sourceRefs: current.sourceRefs,
      entityRefs: current.entityRefs,
      relationRefs: current.relationRefs,
      confidence: current.confidence,
      importance: current.importance,
    });
    expect(retried).toMatchObject({ status: 'noop', committed: false, revision: 2 });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('recovers a lost post-commit response without applying the revision twice', async () => {
    const current = atom();
    const atoms = new Map([[current.id, current]]);
    const manageAtom = vi.fn(fakeRevisionManager(atoms, { throwAfterCommitOnce: true }));
    const service = new MemoryAtomRevisionService({
      management: fakeManagement(atoms, { manageAtom }),
    });
    const proposal = revisionProposal();

    const [uncertain] = await service.revise([proposal]);
    const [recovered] = await service.revise([proposal]);

    expect(uncertain).toMatchObject({ status: 'deferred', committed: false, revision: 1 });
    expect(atoms.get(current.id)).toMatchObject({ revision: 2, content: proposal.replacement.content });
    expect(recovered).toMatchObject({ status: 'noop', committed: false, revision: 2 });
    expect(manageAtom).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale expected revision instead of overwriting concurrent state', async () => {
    const current = atom({ revision: 2, content: 'A concurrent writer changed this projection.' });
    const atoms = new Map([[current.id, current]]);
    const manageAtom = vi.fn(fakeRevisionManager(atoms));
    const service = new MemoryAtomRevisionService({
      management: fakeManagement(atoms, { manageAtom }),
    });

    const [result] = await service.revise([revisionProposal()]);

    expect(result?.reason).toContain('revision changed');
    expect(result).toMatchObject({ status: 'rejected', committed: false, revision: 2 });
    expect(manageAtom).not.toHaveBeenCalled();
  });

  it('rejects wording that no longer represents the same claim', async () => {
    const current = atom();
    const atoms = new Map([[current.id, current]]);
    const manageAtom = vi.fn(fakeRevisionManager(atoms));
    const service = new MemoryAtomRevisionService({
      management: fakeManagement(atoms, { manageAtom }),
    });
    const proposal = revisionProposal({
      title: 'Travel itinerary',
      summary: 'The user plans a mountain trip next winter.',
      content: 'Book a hotel and reserve train tickets for the winter holiday.',
      retrievalKeys: ['travel', 'hotel', 'train'],
    });

    const [result] = await service.revise([proposal]);

    expect(result).toMatchObject({ status: 'rejected', committed: false });
    expect(result?.reason).toContain('does not preserve enough');
    expect(manageAtom).not.toHaveBeenCalled();
  });

  it('rejects dropping or introducing deterministic hard anchors', async () => {
    const current = atom({
      summary: 'The project uses pnpm 11.9.0 from C:\\repo\\package.json.',
      content: 'Run pnpm 11.9.0 for C:\\repo\\package.json workspace commands.',
      retrievalKeys: ['pnpm 11.9.0', 'C:\\repo\\package.json', 'workspace'],
    });

    for (const replacement of [
      {
        title: current.title,
        summary: 'The project uses pnpm 11.9.0 for package management.',
        content: 'Run pnpm 11.9.0 for workspace commands.',
        retrievalKeys: ['pnpm 11.9.0', 'workspace'],
      },
      {
        title: current.title,
        summary: `${current.summary} See https://example.com/new-policy.`,
        content: current.content,
        retrievalKeys: [...current.retrievalKeys, 'https://example.com/new-policy'],
      },
    ]) {
      const atoms = new Map([[current.id, structuredClone(current)]]);
      const manageAtom = vi.fn(fakeRevisionManager(atoms));
      const service = new MemoryAtomRevisionService({
        management: fakeManagement(atoms, { manageAtom }),
      });

      const [result] = await service.revise([revisionProposal(replacement)]);

      expect(result).toMatchObject({ status: 'rejected', committed: false });
      expect(result?.reason).toContain('hard anchor');
      expect(manageAtom).not.toHaveBeenCalled();
    }
  });
});

function atom(overrides: Partial<MemoryAtom> = {}): MemoryAtom {
  return storedAtom({
    id: 'atom-package-manager',
    title: 'Workspace package manager',
    summary: 'The workspace uses pnpm for package management.',
    content: 'Use pnpm workspace commands when operating in this repository.',
    retrievalKeys: ['pnpm', 'workspace', 'package manager'],
    entityRefs: ['entity:workspace', 'entity:pnpm'],
    relationRefs: ['relation:workspace-depends-on-pnpm'],
    ...overrides,
  });
}

function storedAtom(overrides: Partial<MemoryAtom>): MemoryAtom {
  const base = { ...makeStoredAtom(overrides), ...overrides } as MemoryAtom;
  const withoutHash = { ...base };
  delete (withoutHash as Partial<MemoryAtom>).contentHash;
  return { ...withoutHash, contentHash: memoryAtomContentHash(withoutHash) } as MemoryAtom;
}

function revisionProposal(replacement: MemoryAtomRevisionPatch = {
  title: 'Workspace package manager',
  summary: 'This workspace uses pnpm as its package manager.',
  content: 'Use pnpm workspace commands for package operations in this repository.',
  retrievalKeys: ['pnpm', 'workspace', 'package manager'],
}): MemoryAtomRevisionProposal {
  return {
    id: 'run:test:evolve:revision:1',
    action: 'revise',
    basis: 'same-claim-refinement',
    atom: { atomId: 'atom-package-manager', expectedRevision: 1 },
    replacement,
    reason: 'Clarifies the same verified package manager claim without changing its meaning.',
    evidenceRefs: ['run:test:verification:1:pass'],
  };
}

function fakeManagement(
  atoms: Map<string, MemoryAtom>,
  options: { manageAtom?: MemoryRepositoryManagementFacade['manageAtom'] } = {},
): MemoryRepositoryManagementFacade {
  return {
    status: async () => ({ backendKind: 'v3', storageKind: 'atom-catalog', retrievalSupported: true }),
    inspectNode: async (nodeId, disclosureLevel) => {
      const candidate = atoms.get(nodeId);
      return candidate ? {
        backendKind: 'v3' as const,
        nodeId,
        disclosureLevel,
        atom: structuredClone(candidate),
        hasActiveChildren: false,
      } : undefined;
    },
    manageAtom: options.manageAtom ?? fakeRevisionManager(atoms),
    validateMigrationSource: async () => { throw new Error('not used'); },
  };
}

function fakeRevisionManager(
  atoms: Map<string, MemoryAtom>,
  options: { throwAfterCommitOnce?: boolean } = {},
): MemoryRepositoryManagementFacade['manageAtom'] {
  let threwAfterCommit = false;
  return async (request) => {
    const result = applyRevision(atoms, request);
    if (options.throwAfterCommitOnce && !threwAfterCommit) {
      threwAfterCommit = true;
      throw new Error('storage response lost after commit');
    }
    return result;
  };
}

function applyRevision(
  atoms: Map<string, MemoryAtom>,
  request: MemoryAtomManagementRequest,
): MemoryAtomManagementResult {
  if (request.action !== 'revise') throw new Error('test facade only supports revise');
  const current = atoms.get(request.atomId);
  if (!current) throw new Error('atom not found');
  if (current.revision !== request.expectedRevision) throw new Error('revision conflict');
  const updated = storedAtom({
    ...current,
    ...request.patch,
    revision: current.revision + 1,
    updatedAt: '2026-07-17T10:00:00.000Z',
  });
  atoms.set(updated.id, updated);
  return {
    action: 'revise',
    atoms: [structuredClone(updated)],
    audit: {
      id: `audit:${updated.id}:${updated.revision}`,
      action: 'revise',
      at: updated.updatedAt,
      reason: request.reason,
      atomIds: [updated.id],
      before: [state(current)],
      after: [state(updated)],
    },
  };
}

function state(atom: MemoryAtom) {
  return {
    atomId: atom.id,
    revision: atom.revision,
    contentHash: atom.contentHash,
    parentId: atom.parentId,
    status: atom.status,
    epistemicStatus: atom.epistemicStatus,
    resolutionStatus: atom.resolutionStatus,
  };
}
