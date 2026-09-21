// SP-06 (third item): the continuity correction must not reshape the request.
//
// A reply that contradicts what the user just said has to be corrected. How the
// correction is sent matters: the draft came from a real request the Provider may
// already have cached, so a correction that rewrites the system prompt or drops
// the tool catalog forfeits that prefix and pays for the context twice.
//
// Measured before this contract: the correction advertised zero tools, because it
// ran under the REPLY call contract, which allows none, and it appended a
// "Continuity correction contract" to the system prompt, so the first message
// differed too. The tools are restored here; see the taskbook for what the
// system-message difference still needs.
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import type { ChatRequest } from '@littlesheep/llm';
import { textMessage } from '@littlesheep/types';
import { createExecuteStage } from './stages/execute.js';
import { createReplyStage } from './stages/reply.js';
import { createMockLlm, makeCtx, makeTool, textResponse } from './tests/helpers.js';

const deps = { model: 'test', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING };

/** A conversation whose reply is expected to preserve an exact label and value. */
const HISTORY = [
  textMessage('user', '请记住代号 continuity-anchor-6824 和颜色琥珀色。'),
  textMessage('assistant', '记录完成。'),
];
const CONTINUATION = '继续上一轮。请输出上一轮让我保存的代号和颜色，格式为“代号：...；颜色：...”。';
const DISCONTINUOUS_DRAFT = '我无法回忆上一轮保存的内容。';
const CONTINUOUS_REPLY = '代号：continuity-anchor-6824；颜色：琥珀色';

function draftThenCorrection() {
  const requests: ChatRequest[] = [];
  let call = 0;
  const llm = createMockLlm((request) => {
    requests.push(request);
    call += 1;
    return call === 1
      // Contradicts the visible history, which is what raises the correction.
      ? textResponse(DISCONTINUOUS_DRAFT)
      : textResponse(CONTINUOUS_REPLY);
  });
  return { llm, requests };
}

function executeCtx() {
  return makeCtx({
    tools: [makeTool('read', { ok: true, output: 'file' })],
    inbound: textMessage('user', CONTINUATION),
    history: HISTORY,
  });
}

function replyCtx() {
  return makeCtx({
    tools: [makeTool('read', { ok: true, output: 'file' })],
    inbound: textMessage('user', CONTINUATION),
    history: HISTORY,
  });
}

describe('the continuity correction keeps the request shape', () => {
  it('appends bounded feedback instead of rewriting the system prompt', async () => {
    const { llm, requests } = draftThenCorrection();
    const stage = createExecuteStage({ ...deps, llm });

    const outcome = await stage(executeCtx());

    expect(outcome.ok).toBe(true);
    expect(requests).toHaveLength(2);
    const original = requests[0]!;
    const correction = requests[1]!;
    // The correction is new text at the end, never a rewritten instruction.
    expect(String(correction.messages[0]?.content))
      .not.toContain('Continuity correction contract');
    expect(String(correction.messages.at(-2)?.content)).toBe(DISCONTINUOUS_DRAFT);
    expect(String(correction.messages.at(-1)?.content))
      .toContain('the draft above omitted or contradicted');
    expect(correction.messages.length).toBeGreaterThan(original.messages.length);
  });

  it('keeps the tool catalog the draft was generated with', async () => {
    const { llm, requests } = draftThenCorrection();
    const stage = createExecuteStage({ ...deps, llm });

    await stage(executeCtx());

    const original = requests[0]!;
    const correction = requests[1]!;
    // Before: the correction ran under the REPLY contract and advertised no
    // tools at all, so the request prefix could not match.
    expect((original.tools ?? []).length).toBeGreaterThan(0);
    expect(JSON.stringify(correction.tools)).toBe(JSON.stringify(original.tools));
    expect((correction.tools ?? []).map((spec) => spec.function.name))
      .toEqual((original.tools ?? []).map((spec) => spec.function.name));
    // Text-only correction: the catalog stays so the prefix does, and the call
    // is forbidden instead of dropped.
    expect(correction.tool_choice).toBe('none');
  });

  it('keeps every conversation message in order in the correction', async () => {
    const { llm, requests } = draftThenCorrection();
    const stage = createExecuteStage({ ...deps, llm });

    await stage(executeCtx());

    const original = requests[0]!.messages
      .filter((message) => message.role !== 'system')
      .map((message) => JSON.stringify(message));
    const correction = requests[1]!.messages.map((message) => JSON.stringify(message));
    let position = 0;
    for (const message of original) {
      const found = correction.indexOf(message, position);
      expect(found, `conversation message kept in order: ${message.slice(0, 40)}`)
        .toBeGreaterThanOrEqual(position);
      position = found + 1;
    }
  });

  // The correction's first message must be byte-identical to the corrected
  // request's. It used to be reassembled out of the prompt's whole section list,
  // which cut it from 4,058 to 2,323 characters and broke the prefix there. The
  // system message is now the sections above the cache boundary — the same half
  // in both requests — so the correction repeats the corrected request exactly
  // and only appends its feedback.
  it('keeps the first message byte-identical so the prefix survives', async () => {
    const { llm, requests } = draftThenCorrection();
    const stage = createExecuteStage({ ...deps, llm });

    await stage(executeCtx());

    const original = requests[0]!;
    const correction = requests[1]!;
    const originalSystem = String(original.messages[0]?.content);
    const correctionSystem = String(correction.messages[0]?.content);
    expect(originalSystem.length).toBeGreaterThan(1000);
    expect(correctionSystem).toBe(originalSystem);
    // No boundary marker inside the system message: the boundary is where the
    // system message stops.
    expect(correctionSystem).not.toContain('LITTLESHEEP_CACHE_BOUNDARY');
    // Every message of the corrected request is repeated, in order.
    const originalBytes = original.messages.map((message) => JSON.stringify(message));
    const correctionBytes = correction.messages.map((message) => JSON.stringify(message));
    let position = 0;
    for (const message of originalBytes) {
      const found = correctionBytes.indexOf(message, position);
      expect(found, `message repeated in order: ${message.slice(0, 50)}`).toBeGreaterThanOrEqual(position);
      position = found + 1;
    }
  });

  it('does not correct a reply that is already continuous', async () => {
    const requests: ChatRequest[] = [];
    const llm = createMockLlm((request) => {
      requests.push(request);
      return textResponse(CONTINUOUS_REPLY);
    });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = executeCtx();

    await stage(ctx);

    expect(requests).toHaveLength(1);
    expect(ctx.reply).toBe(CONTINUOUS_REPLY);
  });

  it('gives the conversational path the same treatment', async () => {
    const requests: ChatRequest[] = [];
    let call = 0;
    const llm = createMockLlm((request) => {
      requests.push(request);
      call += 1;
      return call === 1 ? textResponse(DISCONTINUOUS_DRAFT) : textResponse(CONTINUOUS_REPLY);
    });
    const stage = createReplyStage({ ...deps, llm });

    const result = await stage(replyCtx());

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(2);
    expect(String(requests[1]!.messages[0]?.content))
      .not.toContain('Continuity correction contract');
    expect(String(requests[1]!.messages.at(-1)?.content))
      .toContain('the draft above omitted or contradicted');
  });
});
