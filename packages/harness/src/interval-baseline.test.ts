// SP-02: the interval baseline must not be rewritten inside a range.
//
// A session summary and the workspace bootstrap files describe the *range* the
// conversation is in. They change when compaction starts a new range — that is
// the documented, deliberate rebuild — and not between rounds of one turn or
// between turns of one range. If either were re-rendered per request, the bytes
// before the conversation would move and every cached prefix after them would be
// forfeited.
//
// This pins that: across a four-round tool loop, and across two turns that share
// a context, the baseline messages are byte-identical and stay where they are.
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import type { ChatRequest } from '@littlesheep/llm';
import { textMessage } from '@littlesheep/types';
import type { CompactionSummary } from '@littlesheep/types';
import { createExecuteStage } from './stages/execute.js';
import { RunTailLedger } from './run-tail-ledger.js';
import { createMockLlm, makeCtx, makeTool, textResponse, toolCallResponse } from './tests/helpers.js';

const deps = { model: 'test', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING };

const SUMMARY: CompactionSummary = {
  version: 1,
  id: 'summary-1',
  summary: 'The user is building a cache-prefix cleanup; the open task is the boundary.',
  compactedAt: '2026-09-21T00:00:00.000Z',
  sourceStartMessageId: 'message-1',
  sourceEndMessageId: 'message-2',
  collapsedCount: 2,
} as CompactionSummary;

function bytes(message: ChatRequest['messages'][number]): string {
  return JSON.stringify(message);
}

/**
 * The baseline messages: the fixed prompt plus the summary and bootstrap
 * sections. They are identified by what they say rather than by index, because
 * where a below-boundary section sits is the layout's business, not this
 * contract's.
 */
function baselineOf(request: ChatRequest): string[] {
  return request.messages
    .slice(1)
    .filter((message) => {
      const content = String(message.content);
      return /session summary/iu.test(content)
        || content.includes('Project Context')
        || content.includes('Workspace instructions for this range.')
        || content.includes('The user is a developer.');
    })
    .map(bytes);
}

function loopContext() {
  const ctx = makeCtx({
    tools: [makeTool('read', { ok: true, output: 'file' })],
    inbound: textMessage('user', 'read the notes'),
    bootstrap: {
      'AGENTS.md': 'Workspace instructions for this range.',
      'USER.md': 'The user is a developer.',
    },
  });
  ctx.sessionSummary = SUMMARY;
  return ctx;
}

describe('the interval baseline is not rewritten inside a range', () => {
  it('keeps the summary and bootstrap byte-identical across four tool rounds', async () => {
    const requests: ChatRequest[] = [];
    let turn = 0;
    const llm = createMockLlm((request) => {
      requests.push(request);
      turn += 1;
      return turn <= 3
        ? toolCallResponse([{ id: `c${turn}`, name: 'read', args: { file_path: `notes-${turn}.md` } }])
        : textResponse('read all three notes');
    });
    const stage = createExecuteStage({ ...deps, llm });

    await stage(loopContext());

    expect(requests).toHaveLength(4);
    const baseline = baselineOf(requests[0]!);
    expect(baseline.length).toBeGreaterThanOrEqual(2);
    expect(baseline.join('\n')).toContain('cache-prefix cleanup');
    expect(baseline.join('\n')).toContain('Workspace instructions for this range.');
    for (const request of requests) {
      // Same bytes, same position.
      expect(baselineOf(request)).toEqual(baseline);
    }
  });

  it('keeps the baseline byte-identical across two turns of one range', async () => {
    const requests: ChatRequest[] = [];
    for (const inbound of ['first turn', 'second turn']) {
      const llm = createMockLlm((request) => {
        requests.push(request);
        return textResponse('done');
      });
      const ctx = loopContext();
      ctx.inbound = textMessage('user', inbound);
      await createExecuteStage({ ...deps, llm })(ctx);
    }

    expect(requests).toHaveLength(2);
    expect(baselineOf(requests[1]!)).toEqual(baselineOf(requests[0]!));
  });

  it('rebuilds the baseline only when compaction hands it a new summary', async () => {
    const requests: ChatRequest[] = [];
    for (const summary of [SUMMARY, { ...SUMMARY, id: 'summary-2', summary: 'A new range began.' }]) {
      const llm = createMockLlm((request) => {
        requests.push(request);
        return textResponse('done');
      });
      const ctx = loopContext();
      ctx.sessionSummary = summary as CompactionSummary;
      await createExecuteStage({ ...deps, llm })(ctx);
    }

    expect(requests).toHaveLength(2);
    // A new summary is a new range: the baseline changes, and it changes as one
    // deliberate rebuild rather than by drifting.
    expect(baselineOf(requests[1]!)).not.toEqual(baselineOf(requests[0]!));
    expect(baselineOf(requests[1]!).join('\n')).toContain('A new range began.');
    expect(baselineOf(requests[0]!).join('\n')).toContain('cache-prefix cleanup');
  });

  // The other half of the same rule: the cache must never freeze a fact that has
  // stopped being true. The Runtime capability facts are re-rendered from the
  // live context on every update, so a change is appended as a new authoritative
  // statement instead of the old one staying in place as if it still held.
  it('appends a changed capability fact instead of freezing the old one', () => {
    const ctx = makeCtx({ inbound: textMessage('user', 'hello') });
    const ledger = new RunTailLedger();
    const setPolicy = (permissionPolicyId: string) => {
      ctx.capabilitySnapshot = {
        epoch: 1,
        permissionPolicyId,
        workspace: 'inside',
        network: { enabled: false, status: 'disabled' },
        tools: [{ name: 'read', status: 'available' as const }],
      } as NonNullable<typeof ctx.capabilitySnapshot>;
    };

    setPolicy('research');
    const first = ledger.update(ctx);
    // Nothing changed: no repeat.
    const unchanged = ledger.update(ctx);
    setPolicy('restricted');
    const afterChange = ledger.update(ctx);

    const firstText = first.messages.map((message) => String(message.content)).join('\n');
    expect(firstText).toContain('permission_policy: research');
    expect(unchanged.messages).toEqual([]);
    const changedText = afterChange.messages.map((message) => String(message.content)).join('\n');
    expect(changedText).toContain('permission_policy: restricted');
    // The earlier statement is still there and still says what it said; the new
    // fact was appended rather than the old one rewritten.
    expect(changedText).not.toContain('permission_policy: research');
  });
});
