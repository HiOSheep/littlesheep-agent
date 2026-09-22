// SP-03: a restart must reuse the recorded session positions.
//
// The item asks the Runtime to reuse the existing persistent session and
// checkpoint boundaries for message/event positions, so that a restart neither
// re-injects content that is already recorded nor repeats a settled side effect.
// The side-effect half is covered end to end by
// `durable-runner-effect-recovery.test.ts`, which SIGKILLs a real effect and
// shows recovery marks it unknown without re-running it. This case covers the
// message half: a fresh runner over the same data root must replay the persisted
// transcript exactly once and in order.
//
// The model reference carries a registered exact tokenizer on purpose. Without
// one the Context Engine can only use the conservative estimator against the
// stage target, and for this prompt the estimate is over target by itself, so
// the optional history is trimmed in *every* run's first request — that is
// budget behaviour, not restart behaviour, and it would hide what this case is
// about.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import type { ChatMessage, ChatRequest } from '@littlesheep/llm';
import { createRunner, type AgentRunner } from './runner.js';
import { createMockLlm, textResponse } from '../../harness/src/tests/helpers.js';

const MODEL = 'deepseek/deepseek-v4-pro';
const roots: string[] = [];
const runners: AgentRunner[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.shutdown().catch(() => undefined)));
  delete process.env.LITTLESHEEP_DATA_DIR;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Every string a message carries, so an inserted tail or summary cannot hide. */
function messageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

function occurrences(requests: readonly ChatRequest[], needle: string): Array<{ request: number; index: number }> {
  const found: Array<{ request: number; index: number }> = [];
  requests.forEach((request, requestIndex) => {
    request.messages.forEach((message, index) => {
      if (messageText(message).includes(needle)) found.push({ request: requestIndex, index });
    });
  });
  return found;
}

describe('session restart continuity', () => {
  it('replays the persisted transcript once when a new runner continues the session', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ls-session-restart-'));
    roots.push(rootDir);
    process.env.LITTLESHEEP_DATA_DIR = rootDir;
    const requests: ChatRequest[] = [];
    const llm = createMockLlm((request) => {
      requests.push(request);
      return textResponse('LS-RESTART-REPLY');
    });
    const first = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: MODEL,
      llm,
    });
    runners.push(first);
    const started = await first.run({ text: 'LS-RESTART-FIRST-QUESTION' });
    expect(started.status).toBe('ok');
    const sessionId = started.sessionId;

    // A restart: a brand-new runner over the same data root, sharing nothing but
    // the persisted session.
    requests.length = 0;
    const second = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: MODEL,
      llm,
    });
    runners.push(second);
    // Runtime tail sections are persisted for byte-exact replay but are not
    // conversation, so the conversational order is asserted without them.
    expect((await second.sessionManager.read(sessionId))
      .filter((message) => message.runtimeTail !== true)
      .map((message) => message.role))
      .toEqual(['user', 'assistant']);
    const continued = await second.run({ sessionId, text: 'LS-RESTART-SECOND-QUESTION' });
    expect(continued.status).toBe('ok');
    expect(continued.sessionId).toBe(sessionId);

    // The recorded turn is replayed once, in the persisted order, and the new
    // turn is appended after it: nothing recorded is injected twice.
    expect(occurrences(requests, 'LS-RESTART-FIRST-QUESTION')).toHaveLength(1);
    expect(occurrences(requests, 'LS-RESTART-REPLY')).toHaveLength(1);
    expect(occurrences(requests, 'LS-RESTART-SECOND-QUESTION')).toHaveLength(1);
    const positions = requests[0]!.messages.map(messageText);
    const firstIndex = positions.findIndex((text) => text.includes('LS-RESTART-FIRST-QUESTION'));
    const replyIndex = positions.findIndex((text) => text.includes('LS-RESTART-REPLY'));
    const secondIndex = positions.findIndex((text) => text.includes('LS-RESTART-SECOND-QUESTION'));
    expect(firstIndex).toBeLessThan(replyIndex);
    expect(replyIndex).toBeLessThan(secondIndex);

    // The persisted transcript is unchanged by the restart, and the new turn is
    // appended to it rather than replacing it.
    expect((await second.sessionManager.read(sessionId))
      .filter((message) => message.runtimeTail !== true)
      .map((message) => message.role))
      .toEqual(['user', 'assistant', 'user', 'assistant']);
  }, 60_000);
});
