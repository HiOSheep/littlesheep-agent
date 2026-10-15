import { describe, expect, it } from 'vitest';
import { reduceConversationTranscript } from './conversation-transcript.js';
import type { ConversationTranscriptEntry, ToolStreamEvent } from './activity.js';

describe('conversation progress', () => {
  it('retains tool-turn prose, tool order, and a cancelled retry without treating it as a final reply', () => {
    let entries: ConversationTranscriptEntry[] = [];
    const text = (summary: string, attempt: number, sequence: number, operation: 'append' | 'replace' | 'reset', status: 'running' | 'done' | 'aborted' = 'running'): ToolStreamEvent => ({
      type: 'model_text', phaseId: 'turn-1', summary, reasoningStatus: status,
      streamRef: { version: 1, runId: 'r', requestId: 'q', transportAttempt: attempt, sequence, operation },
    });
    entries = reduceConversationTranscript(entries, text('先读取', 1, 1, 'append'));
    entries = reduceConversationTranscript(entries, text('文件。', 1, 2, 'append'));
    entries = reduceConversationTranscript(entries, text('', 2, 1, 'reset', 'aborted'));
    entries = reduceConversationTranscript(entries, text('重新读取文件。', 2, 2, 'replace', 'done'));
    entries = reduceConversationTranscript(entries, { type: 'tool_start', callId: 'read-1' });
    entries = reduceConversationTranscript(entries, { type: 'tool_start', callId: 'read-1' });
    expect(entries).toEqual([
      expect.objectContaining({ kind: 'text', text: '先读取文件。', status: 'aborted' }),
      expect.objectContaining({ kind: 'text', text: '重新读取文件。', status: 'done' }),
      { kind: 'tool', id: 'tool:read-1', callId: 'read-1' },
    ]);
  });
});
