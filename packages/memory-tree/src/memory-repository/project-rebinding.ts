// Applies one atomic project-path rebind across nodes, queued writes, and registered resources.

import type { MemoryWritePolicy } from '../types.js';
import type { MemoryDocumentStore } from './document-store.js';
import { normalizedFilePath, rebaseFilePath, sameFilePath } from './path-utils.js';
import { recordMemoryResourceAudit, validateMemoryResourceRegistry } from './resource-store.js';

export interface MemoryProjectRebindResult {
  nodeCount: number;
  recoveryIntentCount: number;
  resourceCount: number;
}

export function rebindMemoryProjectPath(
  documents: MemoryDocumentStore,
  policy: MemoryWritePolicy,
  fromPath: string,
  toPath: string,
): Promise<MemoryProjectRebindResult> {
  const from = normalizedFilePath(fromPath);
  const to = normalizedFilePath(toPath);
  const empty = { nodeCount: 0, recoveryIntentCount: 0, resourceCount: 0 };
  if (sameFilePath(from, to)) return Promise.resolve(empty);

  return documents.update((document) => {
    const result: MemoryProjectRebindResult = { ...empty };
    for (const node of Object.values(document.nodes)) {
      if (node.branch !== 'project' || !node.scopeKey || !sameFilePath(node.scopeKey, from)) continue;
      node.scopeKey = to;
      result.nodeCount += 1;
    }
    for (const queued of document.recoveryQueue) {
      if (queued.intent.branch !== 'project'
        || !queued.intent.scopeKey
        || !sameFilePath(queued.intent.scopeKey, from)) continue;
      queued.intent.scopeKey = to;
      result.recoveryIntentCount += 1;
    }
    for (const resource of Object.values(document.resources)) {
      if (resource.branch !== 'project' || !resource.scopeKey || !sameFilePath(resource.scopeKey, from)) continue;
      const fromSourcePath = resource.source.path;
      resource.scopeKey = to;
      if (resource.source.path) resource.source.path = rebaseFilePath(resource.source.path, from, to);
      resource.updatedAt = new Date().toISOString();
      recordMemoryResourceAudit(document, resource, 'rebind', policy, {
        actor: 'system',
        reason: '项目路径已重新绑定，并保留资源身份。',
        fromSourcePath,
        toSourcePath: resource.source.path,
      });
      result.resourceCount += 1;
    }
    const changed = result.nodeCount > 0 || result.recoveryIntentCount > 0 || result.resourceCount > 0;
    if (changed) validateMemoryResourceRegistry(document.resources);
    return { value: result, changed };
  });
}
