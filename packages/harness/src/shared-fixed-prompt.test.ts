// SP-02: one session must have one fixed prompt.
//
// The Provider matches its prefix cache from token zero. A session alternates
// between conversational turns (REPLY) and tool work (EXECUTE) inside the same
// context, so if those two render different bytes in the fixed prompt neither
// can reuse what the other already prefilled and the whole cached prefix is
// lost on every alternation.
//
// Measured before this contract, for one identical context:
//   fixed prompt grew from 324 shared bytes (the identity line only) to the
//   first divergent byte, because REPLY rendered a "This run is at the REPLY
//   stage" Core Flow variant that EXECUTE did not, and a respond-only memory
//   index paragraph. After unification the shared prefix is 3369 bytes and ends
//   exactly at the cache boundary marker, which is where the two modes are
//   *supposed* to differ: the boundary is the documented invalidation point.
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { CACHE_BOUNDARY_MARKER } from '@littlesheep/prompt';
import type { ChatRequest, ChatMessage } from '@littlesheep/llm';
import { textMessage } from '@littlesheep/types';
import { createExecuteStage } from './stages/execute.js';
import { createReplyStage } from './stages/reply.js';
import { createMockLlm, makeCtx, makeTool, textResponse, toolCallResponse } from './tests/helpers.js';

const deps = { model: 'test', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING };

/** The shared prefix floor: the fixed prompt's stable head. */
const STABLE_HEAD_MIN_BYTES = 3_300;

interface Observed {
  request: ChatRequest;
  system: string;
}

function sameContext(tools: ReturnType<typeof makeTool>[], inbound: string) {
  const ctx = makeCtx({
    tools,
    inbound: textMessage('user', inbound),
    bootstrap: {
      'SOUL.md': 'Use a calm voice.',
      'USER.md': 'The user is a developer.',
      'AGENTS.md': 'Workspace instructions.',
    },
  });
  ctx.memoryRootIndex = '# Memory Tree Root Index\n- `projects`: project facts';
  ctx.profilePromptAddon = 'Profile addon';
  return ctx;
}

async function observeExecute(): Promise<Observed> {
  const requests: ChatRequest[] = [];
  let turn = 0;
  const llm = createMockLlm((request) => {
    requests.push(request);
    turn += 1;
    return turn === 1
      ? toolCallResponse([{ id: 'c1', name: 'lookup', args: { q: 'x' } }])
      : textResponse('done');
  });
  const tool = makeTool('lookup', { ok: true, output: 'found' });
  await createExecuteStage({ ...deps, llm })(sameContext([tool], 'lookup x'));
  return { request: requests[0]!, system: String(requests[0]!.messages[0]!.content) };
}

async function observeReply(): Promise<Observed> {
  const requests: ChatRequest[] = [];
  const llm = createMockLlm((request) => {
    requests.push(request);
    return textResponse('reply');
  });
  const tool = makeTool('lookup', { ok: true, output: 'found' });
  await createReplyStage({ ...deps, llm })(sameContext([tool], 'hello there'));
  return { request: requests[0]!, system: String(requests[0]!.messages[0]!.content) };
}

function sharedPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

function bytes(message: ChatMessage): string {
  return JSON.stringify(message);
}

describe('the fixed prompt is shared by every stage of one session', () => {
  it('renders the same stable head for a conversational turn and a tool turn', async () => {
    const execute = await observeExecute();
    const reply = await observeReply();

    const shared = sharedPrefixLength(execute.system, reply.system);
    expect(shared, `execute/reply shared prefix (execute ${execute.system.length}, reply ${reply.system.length})`)
      .toBeGreaterThanOrEqual(STABLE_HEAD_MIN_BYTES);
    // The divergence must be the documented boundary, not an incidental
    // stage-specific rewrite above it. The system message now *is* the stable
    // half, so the boundary is where the two modes legitimately differ and the
    // shared prefix is the whole shorter message.
    expect(execute.system.slice(0, shared)).toBe(reply.system.slice(0, shared));
    expect(shared).toBe(Math.min(execute.system.length, reply.system.length));
  });

  it('keeps the stage variant out of the shared head, and out of the system message', async () => {
    const execute = await observeExecute();
    const reply = await observeReply();

    // The system message is exactly the sections above the cache boundary, so it
    // carries no boundary marker and no below-boundary prose at all.
    for (const observed of [execute, reply]) {
      const stableHead = observed.system;
      expect(stableHead).not.toContain(CACHE_BOUNDARY_MARKER);
      // Stage-conditional prose above the boundary is what broke prefix reuse:
      // the old variant announced "This run is at the REPLY stage" and nothing
      // else did.
      expect(stableHead).not.toContain('This run is at the');
      expect(stableHead).not.toContain('respond mode');
      // Both modes carry the same facts and the same discipline text.
      expect(stableHead).toContain('# Core Flow');
      expect(stableHead).toContain('# Safety');
      expect(stableHead).toContain('# Workspace');
      expect(stableHead).toContain('Registered in this run: lookup');
      expect(stableHead).toContain('root index -> branch index -> node/query expansion');
      expect(stableHead).toContain('Memory Tree Root Index');
      expect(stableHead).toContain('Profile addon');
    }
  });

  it('sends the below-boundary sections as their own messages', async () => {
    const execute = await observeExecute();

    const tail = execute.request.messages
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content));
    // The bootstrap files, the run/disclosure section and the retrieval contract
    // are below the boundary, so they travel beside the conversation instead of
    // inside the system message.
    expect(tail.join('\n')).toContain('Workspace instructions.');
    expect(tail.join('\n')).toContain('# Runtime');
    expect(tail.join('\n')).toContain('Runtime retrieval intent');
    expect(tail.join('\n')).toContain('# Runtime Facts');
  });

  it('keeps the conversation ordered identically in both paths', async () => {
    const execute = await observeExecute();
    const reply = await observeReply();

    for (const observed of [execute, reply]) {
      const roles = observed.request.messages.map((message) => message.role);
      // The fixed prompt opens the request, the user turn appears exactly once,
      // and every other message is a system section: the runtime facts block and
      // the below-boundary sections are separate messages rather than being
      // folded into the fixed prompt.
      expect(roles[0]).toBe('system');
      const userIndices = roles
        .map((role, index) => (role === 'user' ? index : -1))
        .filter((index) => index >= 0);
      expect(userIndices).toHaveLength(1);
      expect(userIndices[0]).toBeGreaterThan(0);
      expect(roles.filter((role) => role === 'system').length).toBeGreaterThanOrEqual(2);
      expect(observed.request.messages[0]!.content).toBeTruthy();
    }
  });
});
