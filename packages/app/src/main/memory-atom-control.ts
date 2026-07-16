// Advanced Memory v3 atom management and evidence export for the Local App API.

import { mkdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { atomicWrite } from '@littlesheep/memory-core';
import type {
  MemoryAtomManagementRequest,
  MemoryAtomManagementResult,
  MemoryRepositoryNodeInspection,
} from '@littlesheep/memory-tree';
import type { AgentRunner } from '@littlesheep/runner';

export type ManageRuntimeMemoryAtomResult =
  | { status: 'not_found' }
  | { status: 'unsupported'; error: string }
  | { status: 'invalid'; error: string }
  | { status: 'changed'; result: MemoryAtomManagementResult };

export async function manageRuntimeMemoryAtom(
  runner: AgentRunner,
  request: MemoryAtomManagementRequest,
): Promise<ManageRuntimeMemoryAtomResult> {
  const existing = await runner.infra.memoryService.getNode(request.atomId);
  if (!existing || existing.isBranchRoot) return { status: 'not_found' };
  const status = await runner.infra.memoryRepository.management.status();
  if (status.backendKind !== 'v3') {
    return { status: 'unsupported', error: 'Advanced atom management requires the Memory v3 backend.' };
  }
  try {
    const result = await runner.infra.memoryRepository.management.manageAtom(request);
    for (const branch of new Set(result.atoms.map((atom) => atom.branch))) {
      await runner.infra.memoryTree.invalidateBranch(branch);
    }
    return { status: 'changed', result };
  } catch (error) {
    return { status: 'invalid', error: errorMessage(error) };
  }
}

export interface MemoryAtomEvidenceExportResult {
  outputPath: string;
  atomId: string;
  revision: number;
  immutableFactCount: number;
  exportedAt: string;
}

export async function exportRuntimeMemoryAtom(
  runner: AgentRunner,
  atomId: string,
  outputPath: string,
): Promise<MemoryAtomEvidenceExportResult | undefined> {
  const inspection = await runner.infra.memoryRepository.management.inspectNode(atomId, 'D3');
  if (!inspection?.atom) return undefined;
  const exportedAt = new Date().toISOString();
  const evidencePackage = buildEvidencePackage(inspection, exportedAt);
  await mkdir(dirname(outputPath), { recursive: true });
  await atomicWrite(outputPath, `${JSON.stringify(evidencePackage, null, 2)}\n`);
  return {
    outputPath,
    atomId,
    revision: inspection.atom.revision,
    immutableFactCount: inspection.immutableFacts?.length ?? 0,
    exportedAt,
  };
}

export function suggestedMemoryAtomExportName(atomId: string, title?: string): string {
  const preferred = cleanFileName(title ?? '') || cleanFileName(basename(atomId)) || 'memory-atom';
  return `${preferred}.memory.json`;
}

function buildEvidencePackage(inspection: MemoryRepositoryNodeInspection, exportedAt: string) {
  return {
    version: 1,
    kind: 'littlesheep-memory-atom-evidence',
    exportedAt,
    backendKind: inspection.backendKind,
    disclosureLevel: 'D3',
    nodeId: inspection.nodeId,
    atom: inspection.atom,
    catalog: inspection.catalog,
    envelope: inspection.envelope,
    neighborhood: inspection.neighborhood,
    history: inspection.history,
    immutableFacts: inspection.immutableFacts ?? [],
  };
}

function cleanFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '-').trim().slice(0, 120);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
