// Owns immutable conversation sources and evidence-bound run feedback.

import type { MemoryRunFeedbackInput } from '../memory-feedback-contract.js';
import type { MemoryAtom } from '../v3/contracts.js';
import {
  MemoryConversationSourceStore,
  type MemoryConversationSourceBackfillInput,
  type MemoryConversationSourceBackfillResult,
  type MemoryConversationSourceCatalogPage,
  type MemoryConversationSourceCatalogQuery,
  type MemoryConversationSourceInput,
  type MemoryConversationSourceRecord,
} from '../conversation-source-store.js';
import { memoryUseFeedbackFromRun } from '../memory-feedback.js';
import type { MemoryRepository } from '../memory-repository.js';

export type {
  MemoryConversationSourceBackfillInput,
  MemoryConversationSourceBackfillResult,
  MemoryConversationSourceCatalogEntry,
  MemoryConversationSourceCatalogPage,
  MemoryConversationSourceCatalogQuery,
  MemoryConversationSourceCatalogStatus,
  MemoryConversationSourceInput,
  MemoryConversationSourceRecord,
  MemoryConversationSourceWatermark,
} from '../conversation-source-store.js';

export class MemorySourceFeedbackCoordinator {
  private readonly sources: MemoryConversationSourceStore;

  constructor(dataDir: string, private readonly repository: MemoryRepository) {
    this.sources = new MemoryConversationSourceStore({ dataDir });
  }

  capture(inputs: MemoryConversationSourceInput[]): Promise<MemoryConversationSourceRecord[]> {
    if (this.repository.backendKind !== 'v3') return Promise.resolve([]);
    return this.sources.captureMany(inputs);
  }

  list(sourceRefs: string[], limit = 100): Promise<MemoryConversationSourceRecord[]> {
    if (this.repository.backendKind !== 'v3') return Promise.resolve([]);
    return this.sources.getMany(sourceRefs, limit);
  }

  /**
   * A non-v3 backend has no conversation-source index. Returning an empty page would
   * pretend the sources are absent, so the catalog explicitly reports `unsupported`.
   */
  async catalog(query: MemoryConversationSourceCatalogQuery): Promise<MemoryConversationSourceCatalogPage> {
    if (!query.sessionId?.trim() && !query.runId?.trim()) {
      throw new Error('Conversation source catalog requires a sessionId or runId scope.');
    }
    if (this.repository.backendKind !== 'v3') {
      return {
        status: 'unsupported',
        reason: 'Conversation sources are only indexed by the v3 memory backend.',
        entries: [],
        scanned: 0,
      };
    }
    return this.sources.catalog(query);
  }

  /**
   * HC-12: a source cited by a superseded/tombstoned/merged atom stays raw audit
   * evidence, not a current valid preference. Callers use this to label recall.
   */
  async revocationStatus(sourceIds: readonly string[]): Promise<{ status: 'ok' | 'unsupported'; revoked: string[] }> {
    if (this.repository.backendKind !== 'v3') return { status: 'unsupported', revoked: [] };
    const wanted = new Set(sourceIds.slice(0, 64).map((id) => id.trim()).filter(Boolean));
    if (wanted.size === 0) return { status: 'ok', revoked: [] };
    const revoked = new Set<string>();
    for (const branch of ['long-term', 'daily', 'project', 'experience'] as const) {
      let nodes;
      try {
        nodes = await this.repository.listNodes(branch);
      } catch {
        continue;
      }
      for (const node of nodes) {
        const revokedNode = node.status === 'deleted'
          || node.epistemicStatus === 'superseded'
          || Boolean(node.mergedIntoId)
          || Boolean(node.invalidatedAt);
        if (!revokedNode) continue;
        for (const ref of node.sourceRefs ?? []) {
          if (wanted.has(ref)) revoked.add(ref);
        }
      }
    }
    return { status: 'ok', revoked: [...revoked].sort() };
  }

  /**
   * HC-02: a resumable first backfill. Non-v3 backends have no source index, so
   * they report nothing captured instead of pretending the history was imported.
   */
  backfill(input: MemoryConversationSourceBackfillInput): Promise<MemoryConversationSourceBackfillResult> {
    if (this.repository.backendKind !== 'v3') return Promise.resolve({ captured: [], resumed: false });
    return this.sources.backfill(input);
  }

  recordRunFeedback(input: MemoryRunFeedbackInput): Promise<MemoryAtom[]> {
    if (this.repository.backendKind !== 'v3') return Promise.resolve([]);
    return this.repository.recordMemoryFeedback(memoryUseFeedbackFromRun(input));
  }
}
