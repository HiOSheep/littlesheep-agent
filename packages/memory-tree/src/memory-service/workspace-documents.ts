// Discovers only bounded formal workspace documents and registers metadata, not bodies.

import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { InjectionTier } from '../types.js';
import type { MemoryResourceRegistration } from '../types.js';
import type { MemoryRepository } from '../memory-repository.js';
import {
  documentKind,
  fileResourceId,
  isWorkspaceDocument,
  normalizedPath,
  workspaceDocumentRegistryGroup,
  workspaceDisplayTitle,
} from './resource-identifiers.js';

const MAX_WORKSPACE_DOCUMENTS = 64;
const MAX_WORKSPACE_DOCUMENT_DIRECTORIES = 128;
const MAX_WORKSPACE_DOCUMENT_DEPTH = 5;
const SKIPPED_WORKSPACE_DOCUMENT_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'out', 'build', 'coverage',
]);

export class WorkspaceDocumentCoordinator {
  constructor(private readonly repository: MemoryRepository) {}

  registryGroup(workspace: string): string {
    return workspaceDocumentRegistryGroup(resolve(workspace));
  }

  async sync(workspace: string): Promise<void> {
    const root = resolve(workspace);
    const group = this.registryGroup(root);
    const existing = await this.repository.listResources({ registryGroup: group });
    const existingByPath = new Map(existing
      .filter((resource) => resource.source.path)
      .map((resource) => [normalizedPath(resource.source.path!), resource]));
    const candidates = new Set<string>();
    const readDirectory = async (dir: string, recursive: boolean): Promise<void> => {
      const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
      let visited = 0;
      while (queue.length > 0
        && candidates.size < MAX_WORKSPACE_DOCUMENTS
        && visited < MAX_WORKSPACE_DOCUMENT_DIRECTORIES) {
        const current = queue.shift()!;
        visited += 1;
        let entries: import('node:fs').Dirent[];
        try {
          entries = await readdir(current.dir, { withFileTypes: true });
        } catch {
          continue;
        }
        entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
        for (const entry of entries) {
          if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.md') && isWorkspaceDocument(entry.name)) {
            candidates.add(join(current.dir, entry.name));
            if (candidates.size >= MAX_WORKSPACE_DOCUMENTS) break;
            continue;
          }
          if (!recursive || !entry.isDirectory() || current.depth >= MAX_WORKSPACE_DOCUMENT_DEPTH) continue;
          const lower = entry.name.toLocaleLowerCase();
          if (entry.name.startsWith('.') || SKIPPED_WORKSPACE_DOCUMENT_DIRS.has(lower)) continue;
          queue.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
        }
      }
    };
    await readDirectory(root, false);
    if (candidates.size < MAX_WORKSPACE_DOCUMENTS) await readDirectory(join(root, 'docs'), true);

    const now = new Date().toISOString();
    const resources: MemoryResourceRegistration[] = [];
    for (const path of [...candidates].slice(0, MAX_WORKSPACE_DOCUMENTS)) {
      const prior = existingByPath.get(normalizedPath(path));
      let fileUpdatedAt = now;
      let status: MemoryResourceRegistration['status'] = 'active';
      try {
        fileUpdatedAt = (await stat(path)).mtime.toISOString();
      } catch {
        status = 'missing';
      }
      const kind = documentKind(basename(path));
      const relativeTitle = relative(root, path).replace(/[\\/]+/g, '/');
      resources.push({
        version: 1,
        id: prior?.id ?? fileResourceId(path),
        kind,
        title: workspaceDisplayTitle(root, path),
        description: '工作区正式文档已登记为索引资源，正文不会默认常驻上下文。',
        tier: kind === 'project-guideline' ? InjectionTier.T1_ESSENTIAL : InjectionTier.T2_RELEVANT,
        branch: 'project',
        scope: 'workspace',
        scopeKey: root,
        authority: 'authoritative',
        privacy: 'project-private',
        source: { kind: 'file', path },
        indexKeys: [relativeTitle, basename(path), kind, basename(root)],
        status,
        registryGroup: group,
        registeredAt: now,
        updatedAt: fileUpdatedAt,
      });
    }
    await this.repository.replaceResourceGroup(group, resources);
  }
}
