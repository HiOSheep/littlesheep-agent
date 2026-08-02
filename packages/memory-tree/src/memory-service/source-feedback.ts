// Owns immutable conversation sources and evidence-bound run feedback.

import type { MemoryRunFeedbackInput } from '../memory-feedback-contract.js';
import type { MemoryAtom } from '../v3/contracts.js';
import {
  MemoryConversationSourceStore,
  type MemoryConversationSourceInput,
  type MemoryConversationSourceRecord,
} from '../conversation-source-store.js';
import { memoryUseFeedbackFromRun } from '../memory-feedback.js';
import type { MemoryRepository } from '../memory-repository.js';

export type { MemoryConversationSourceInput, MemoryConversationSourceRecord };

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

  recordRunFeedback(input: MemoryRunFeedbackInput): Promise<MemoryAtom[]> {
    if (this.repository.backendKind !== 'v3') return Promise.resolve([]);
    return this.repository.recordMemoryFeedback(memoryUseFeedbackFromRun(input));
  }
}
