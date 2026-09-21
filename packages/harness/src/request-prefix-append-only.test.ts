// SP-01: the request the Provider actually receives must be append-only.
//
// A Provider prefix cache only matches from token zero, so iteration N+1 of the
// main loop has to repeat every message of iteration N byte for byte and only
// append after it. The earlier "strict extension" case in execute.test.ts could
// not show this: it stripped the trailing system messages before comparing, so a
// rebuilt-and-moved tail passed. These cases compare the complete request, the
// tool definitions included, and they cover the situations the offline prompt
// audit reproduced: a per-turn retrieval contract, memory release notes, a
// changing Memory KnownState, and a resumed session.
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import type { ChatRequest, ChatMessage } from '@littlesheep/llm';
import type { Message, RuntimeMemoryKnownState } from '@littlesheep/types';
import { CACHE_BOUNDARY_MARKER } from '@littlesheep/prompt';
import { textMessage } from '@littlesheep/types';
import { createExecuteStage } from './stages/execute.js';
import { createMockLlm, makeCtx, makeTool, textResponse, toolCallResponse } from './tests/helpers.js';

const deps = { model: 'test', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING };

function bytes(message: ChatMessage): string {
  return JSON.stringify(message);
}

/** Roles of every message, for a compact failure message. */
function roles(request: ChatRequest): string {
  return request.messages.map((message) => message.role[0]).join('');
}

/**
 * Every request must repeat the complete previous request and only append.
 * The first rewritten message is reported by position, role and offset, so a
 * failure names the exact regression instead of dumping whole prompts.
 */
function expectAppendOnly(requests: readonly ChatRequest[]): void {
  expect(requests.length).toBeGreaterThan(1);
  for (let index = 1; index < requests.length; index += 1) {
    const previous = requests[index - 1]!;
    const current = requests[index]!;
    const label = `request ${index} -> ${index + 1}`;
    expect(current.messages.length, `${label} grew`).toBeGreaterThan(previous.messages.length);
    for (let position = 0; position < previous.messages.length; position += 1) {
      const before = bytes(previous.messages[position]!);
      const after = bytes(current.messages[position]!);
      if (before === after) continue;
      const beforeCharacters = [...before];
      const afterCharacters = [...after];
      const offset = beforeCharacters.findIndex((value, offset_) => value !== afterCharacters[offset_]);
      throw new Error(
        `${label}: message ${position} (${previous.messages[position]!.role}) was rewritten at ${offset}`
        + `\n  previous ${roles(previous)}: ${before.slice(Math.max(0, offset - 60), offset + 60)}`
        + `\n  current  ${roles(current)}: ${after.slice(Math.max(0, offset - 60), offset + 60)}`,
      );
    }
    expect(current.tools, `${label} tools`).toEqual(previous.tools);
    expect(current.tool_choice, `${label} tool_choice`).toBe(previous.tool_choice);
  }
}

function knownState(runId: string): RuntimeMemoryKnownState {
  return {
    version: 1,
    runId,
    revision: 4,
    updatedAt: '2026-09-21T00:00:00.000Z',
    references: [{
      atomId: 'atom-1',
      atomRevision: 3,
      decision: 'adopted',
      reason: 'matched the active project scope',
      stages: ['execute'],
      firstSeenAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
      reactivatedCount: 0,
      envelope: {
        atomId: 'atom-1',
        atomRevision: 3,
        branch: 'projects',
        scope: 'project',
        tier: 2,
        disclosureLevel: 'D2',
        statementKind: 'fact',
        epistemicStatus: 'verified',
        authorityScope: { kind: 'project', scope: 'project', topics: [] },
        assertedBy: { kind: 'user' },
        evidenceRefs: ['evidence:1'],
        sourceRefs: [],
        confidence: 0.9,
        importance: 0.8,
        updatedAt: '2026-09-21T00:00:00.000Z',
        retrievalPath: 'hierarchy',
        matchReason: 'branch match',
        conflict: false,
        expired: false,
        truncated: false,
      },
    }],
  };
}

describe('main-loop request is append-only', () => {
  it('extends the complete previous request across three tool rounds', async () => {
    const requests: ChatRequest[] = [];
    let turn = 0;
    const llm = createMockLlm((request) => {
      requests.push(request);
      turn += 1;
      return turn <= 3
        ? toolCallResponse([{ id: `c${turn}`, name: 'lookup', args: { q: turn } }])
        : textResponse('final');
    });
    const tool = makeTool('lookup', { ok: true, output: 'found-it' });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({
      tools: [tool],
      inbound: textMessage('user', 'lookup x'),
      history: [
        textMessage('user', 'first question'),
        textMessage('assistant', 'first answer'),
      ],
    });

    const outcome = await stage(ctx);

    expect(outcome).toMatchObject({ next: 'verify', ok: true });
    expect(requests).toHaveLength(4);
    expectAppendOnly(requests);
    expect(requests[0]!.messages.filter((message) => message.role === 'system').length)
      .toBeGreaterThan(0);
  });

  it('appends the retrieval contract once and keeps it in place', async () => {
    const requests: ChatRequest[] = [];
    let turn = 0;
    const llm = createMockLlm((request) => {
      requests.push(request);
      turn += 1;
      return turn <= 2
        ? toolCallResponse([{ id: `c${turn}`, name: 'lookup', args: { q: turn } }])
        : textResponse('final');
    });
    const tool = makeTool('lookup', { ok: true, output: 'found-it' });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'lookup x') });

    await stage(ctx);

    expectAppendOnly(requests);
    const contractIndex = requests[0]!.messages.findIndex((message) => (
      typeof message.content === 'string' && message.content.includes('Runtime retrieval intent')
    ));
    expect(contractIndex).toBeGreaterThan(0);
    const contract = bytes(requests[0]!.messages[contractIndex]!);
    for (const request of requests) {
      expect(bytes(request.messages[contractIndex]!)).toBe(contract);
      expect(request.messages.filter((message) => (
        typeof message.content === 'string' && message.content.includes('Runtime retrieval intent')
      ))).toHaveLength(1);
    }
  });

  it('keeps the whole previous request when released memory is re-expanded (A->B->A)', async () => {
    const requests: ChatRequest[] = [];
    // The sequence the tail must express: A active -> A released, B expanded ->
    // A active again. A text-dedup ledger would break the cache here; an
    // append-only ledger records both transitions and stays a prefix.
    const states = [
      { active: ['atom-a'], callMap: { callA: ['atom-a'] } },
      { active: ['atom-b'], callMap: { callA: ['atom-a'], callB: ['atom-b'] } },
      { active: ['atom-a'], callMap: { callA: ['atom-a'], callB: ['atom-b'] } },
    ];
    let applied = 0;
    let ctx!: ReturnType<typeof makeCtx>;
    const applyState = () => {
      const state = states[Math.min(applied, states.length - 1)]!;
      const activeSet = new Set(state.active);
      const workingSet = {
        revision: applied + 1,
        activeAtomIds: [...state.active],
        releasedAtomIds: Object.values(state.callMap).flat().filter((id) => !activeSet.has(id)),
        activeCallByAtom: Object.fromEntries(state.active.map((id) => [
          id,
          Object.entries(state.callMap).find(([, ids]) => ids.includes(id))![0],
        ])),
        callAtomIds: state.callMap,
        updatedAt: `2026-09-21T00:00:0${applied}.000Z`,
      };
      applied += 1;
      // The Runtime owns this state; the loop must only read it.
      (ctx as { memoryContextWorkingSet?: unknown }).memoryContextWorkingSet = workingSet;
      return workingSet;
    };
    let turn = 0;
    const llm = createMockLlm((request) => {
      requests.push(request);
      turn += 1;
      return turn <= 2
        ? toolCallResponse([{ id: `c${turn}`, name: 'memory_tree', args: { action: 'expand' } }])
        : textResponse('final');
    });
    const tool = makeTool('memory_tree', { ok: true, output: 'atoms' });
    const stage = createExecuteStage({ ...deps, llm });
    ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'expand memory') });

    // Apply the first state before the loop starts and the later ones while the
    // loop is running, exactly like a memory tool result would.
    applyState();
    tool.execute = async () => {
      const next = applyState();
      return { callId: '', ok: true, output: `atoms:${next.activeAtomIds.join(',')}`, durationMs: 1 };
    };

    await stage(ctx);

    expect(requests).toHaveLength(3);
    expectAppendOnly(requests);
    const all = requests[2]!.messages.map((message) => String(message.content)).join('\n');
    // The release of atom-a and the expansion of atom-b are recorded as
    // appended events; neither rewrites an earlier message.
    expect(all).toContain('released_atoms: atom-a');
    expect(all).toContain('released_atoms: atom-b');
  });

  it('appends a changed Memory KnownState without rewriting the earlier one', async () => {
    const requests: ChatRequest[] = [];
    let turn = 0;
    const llm = createMockLlm((request) => {
      requests.push(request);
      turn += 1;
      return turn <= 2
        ? toolCallResponse([{ id: `c${turn}`, name: 'memory_tree', args: { action: 'expand' } }])
        : textResponse('final');
    });
    const tool = makeTool('memory_tree', { ok: true, output: 'atoms' });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'expand memory') });
    ctx.memoryKnownState = knownState(ctx.runId);
    // The first tool round publishes a new revision, as a memory tool result does.
    tool.execute = async () => {
      ctx.memoryKnownState = {
        ...knownState(ctx.runId),
        revision: 9,
        updatedAt: '2026-09-21T00:01:00.000Z',
      };
      return { callId: '', ok: true, output: 'atoms', durationMs: 1 };
    };

    await stage(ctx);

    expect(requests).toHaveLength(3);
    expectAppendOnly(requests);
    expect(requests[2]!.messages.filter((message) => (
      typeof message.content === 'string' && message.content.includes('# Run Memory KnownState')
    )).length).toBeGreaterThanOrEqual(1);
  });

  it('keeps one stable head inside a compaction range', async () => {
    const requests: ChatRequest[] = [];
    let turn = 0;
    const llm = createMockLlm((request) => {
      requests.push(request);
      turn += 1;
      return turn <= 3
        ? toolCallResponse([{ id: `c${turn}`, name: 'lookup', args: { q: turn } }])
        : textResponse('final');
    });
    const tool = makeTool('lookup', { ok: true, output: 'found-it' });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'lookup x') });

    await stage(ctx);

    expectAppendOnly(requests);
    // A compaction boundary is the one allowed rebuild. Inside a range the head
    // is byte-identical from the first request on, and the boundary marker only
    // ever travels inside the original system message — never as a re-appended
    // trailing section at a new position.
    const headLength = requests[0]!.messages.length;
    const head = requests[0]!.messages.slice(0, headLength).map(bytes).join('\n');
    for (const request of requests) {
      expect(request.messages.slice(0, headLength).map(bytes).join('\n')).toBe(head);
      expect(request.messages.filter((message) => (
        typeof message.content === 'string' && message.content.includes(CACHE_BOUNDARY_MARKER)
      ))).toHaveLength(1);
    }
    expect(requests[0]!.messages[0]!.role).toBe('system');
  });

  it('keeps the tool catalog byte-identical across every round of one turn', async () => {
    const requests: ChatRequest[] = [];
    let turn = 0;
    const llm = createMockLlm((request) => {
      requests.push(request);
      turn += 1;
      return turn === 1
        ? toolCallResponse([{ id: 'c1', name: 'lookup', args: { q: 'x' } }])
        : textResponse('final');
    });
    const lookup = makeTool('lookup', { ok: true, output: 'found-it' });
    const glob = makeTool('glob', { ok: true, output: 'files' });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [lookup, glob], inbound: textMessage('user', 'lookup x') });

    await stage(ctx);

    expect(requests.length).toBeGreaterThan(1);
    const catalog = JSON.stringify(requests[0]!.tools);
    expect(catalog).toBeTruthy();
    for (const request of requests) {
      expect(JSON.stringify(request.tools)).toBe(catalog);
    }
  });

  it('refuses to trim an already sent message when the request goes over the stage target', async () => {
    // Context trimming is the one part of assembly that can re-order a request
    // the loop has already sent: dropping a message from the middle shifts every
    // message after it. The loop therefore declares the request append-only, and
    // this case holds the assembly to it.
    const requests: ChatRequest[] = [];
    let turn = 0;
    const llm = createMockLlm((request) => {
      requests.push(request);
      turn += 1;
      return turn === 1
        ? toolCallResponse([{ id: 'c1', name: 'lookup', args: { q: 'x' } }])
        : textResponse('final');
    });
    const tool = makeTool('lookup', { ok: true, output: 'x'.repeat(20_000) });
    const stage = createExecuteStage({ ...deps, llm });
    // Sized so the first request fits under the contract's stage target (24,000
    // estimated prompt tokens for `execute_tool_loop`) and the tool result pushes
    // the second one over it. If prompt sizes drift, the over-target assertion
    // below fails loudly instead of this case silently losing its pressure.
    const ctx = makeCtx({
      tools: [tool],
      inbound: textMessage('user', 'lookup x'),
      history: [
        textMessage('user', 'a'.repeat(8_777)),
        textMessage('assistant', 'b'.repeat(8_777)),
      ],
    });

    const outcome = await stage(ctx);

    expect(outcome).toMatchObject({ next: 'verify', ok: true });
    expect(requests).toHaveLength(2);
    expectAppendOnly(requests);
    const stageTarget = 24_000;
    const estimates = (ctx.contextSnapshots ?? []).map((snapshot) => (
      snapshot.safetyEstimate?.estimatedPromptTokens ?? 0
    ));
    expect(estimates[1]).toBeGreaterThan(stageTarget);
    // Nothing the first request delivered may be missing from the second, and no
    // message may have been rewritten: the system message, the history and the
    // appended tail facts all survive verbatim.
    expect(requests[1]!.messages.slice(0, requests[0]!.messages.length))
      .toEqual(requests[0]!.messages);
  });

  it('keeps prior conversation history byte-identical when a run continues', async () => {
    const history: Message[] = [
      textMessage('user', 'earlier question'),
      textMessage('assistant', 'earlier answer'),
      textMessage('user', 'follow-up question'),
      textMessage('assistant', 'follow-up answer'),
    ];
    const requests: ChatRequest[] = [];
    let turn = 0;
    const llm = createMockLlm((request) => {
      requests.push(request);
      turn += 1;
      return turn === 1
        ? toolCallResponse([{ id: 'c1', name: 'lookup', args: { q: 'x' } }])
        : textResponse('continued');
    });
    const tool = makeTool('lookup', { ok: true, output: 'found-it' });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'continue'), history });

    await stage(ctx);

    expectAppendOnly(requests);
    // History is replayed verbatim, in order, with nothing inserted between the
    // messages: a resumed run must not rewrite the prefix it already sent.
    const historyStart = requests[0]!.messages.findIndex((message) => (
      message.role === 'user' && message.content === 'earlier question'
    ));
    expect(historyStart).toBeGreaterThan(-1);
    expect(requests[0]!.messages
      .slice(historyStart, historyStart + 4)
      .map((message) => message.content)).toEqual([
      'earlier question',
      'earlier answer',
      'follow-up question',
      'follow-up answer',
    ]);
  });
});
