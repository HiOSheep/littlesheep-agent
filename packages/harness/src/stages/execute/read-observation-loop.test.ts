// CE-06: a repeated observation is not a replay.
//
// The reported loop was: inspect the workspace, create the artifact, inspect
// again to confirm. The third call was refused as `side_effect_replay`, because
// every `exec` is an opaque operation the Runtime must assume can write — so the
// user had to say "continue" before the model could look at its own output.
//
// The contract this pins down: the structured read-only tools are how a fresh
// observation is taken, they are never blocked, and an opaque command stays
// opaque. The refusal itself is final for the call but not for the run, so the
// model can switch to a structured tool instead of ending the turn.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { textMessage } from '@littlesheep/types';
import type { AgentTool } from '@littlesheep/types';
import { createExecuteStage } from '../execute.js';
import { createMockLlm, makeCtx, makeTool, textResponse, toolCallResponse } from '../../tests/helpers.js';

const deps = { model: 'test', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING };

/** A structured read-only listing: it declares read resources, so it is an observation. */
function listingTool(read: () => string): AgentTool & { calls: unknown[] } {
  const tool = makeTool('glob', { ok: true, output: '' }) as AgentTool & { calls: unknown[] };
  (tool as { execute: AgentTool['execute'] }).execute = async () => {
    tool.calls.push({});
    return { callId: '', ok: true, output: read() };
  };
  tool.execution = {
    concurrency: 'parallel',
    resources: () => [{ key: 'fs:workspace', mode: 'read' as const }],
  };
  return tool;
}

/** A writer: it declares a write resource, so it is an effect. */
function writerTool(onWrite: () => void): AgentTool & { calls: unknown[] } {
  const tool = makeTool('write', { ok: true, output: 'wrote game.html' }) as AgentTool & { calls: unknown[] };
  (tool as { execute: AgentTool['execute'] }).execute = async () => {
    tool.calls.push({});
    onWrite();
    return { callId: '', ok: true, output: 'wrote game.html' };
  };
  tool.execution = {
    concurrency: 'exclusive',
    resources: () => [{ key: 'fs:game.html', mode: 'write' as const }],
  };
  return tool;
}

/** An opaque command runner: no declared resources, so every call is an effect. */
function opaqueExecTool(): AgentTool & { calls: unknown[] } {
  const tool = makeTool('exec', { ok: true, output: 'notes.txt' }) as AgentTool & { calls: unknown[] };
  (tool as { execute: AgentTool['execute'] }).execute = async () => {
    tool.calls.push({});
    return { callId: '', ok: true, output: 'notes.txt' };
  };
  tool.execution = { concurrency: 'exclusive' };
  return tool;
}

describe('a fresh observation after a write', () => {
  it('lists, writes, and lists again without any replay refusal', async () => {
    let entries = 'notes.txt';
    let turn = 0;
    const llm = createMockLlm(() => {
      turn += 1;
      if (turn === 1) return toolCallResponse([{ id: 'list-1', name: 'glob', args: { pattern: '*' } }]);
      if (turn === 2) return toolCallResponse([{ id: 'write-1', name: 'write', args: { file_path: 'game.html' } }]);
      if (turn === 3) return toolCallResponse([{ id: 'list-2', name: 'glob', args: { pattern: '*' } }]);
      return textResponse('created game.html and confirmed it is in the directory');
    });
    const glob = listingTool(() => entries);
    const write = writerTool(() => { entries = 'game.html\nnotes.txt'; });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [glob, write], inbound: textMessage('user', '做一个小游戏吧') });

    const result = await stage(ctx);

    expect(result, result.error).toMatchObject({ ok: true, next: 'verify' });
    // Both listings actually ran, and the second one observed the new entry.
    expect(glob.calls).toHaveLength(2);
    expect(write.calls).toHaveLength(1);
    const listingOutputs = (ctx.toolResults ?? [])
      .filter((entry) => entry.ok && typeof entry.output === 'string' && entry.output.includes('notes.txt'))
      .map((entry) => entry.output);
    expect(listingOutputs).toContain('game.html\nnotes.txt');
    expect((ctx.toolResults ?? []).some((entry) => /replay/i.test(entry.error ?? ''))).toBe(false);
    expect(ctx.reply).toBe('created game.html and confirmed it is in the directory');
  });

  it('bounds an unchanged repeated observation without calling it a replay', async () => {
    const glob = listingTool(() => 'notes.txt');
    const llm = createMockLlm(() => toolCallResponse([{ id: `list-${Math.random()}`, name: 'glob', args: { pattern: '*' } }]));
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [glob], inbound: textMessage('user', '列出目录') });

    await stage(ctx);

    // No ledger entry exists for an observation, so the bound comes from the
    // no-progress budget: the first listing is new evidence, the repeats are not.
    expect(glob.calls).toHaveLength(3);
    expect((ctx.toolResults ?? []).some((entry) => /replay/i.test(entry.error ?? ''))).toBe(false);
  });
});

describe('an opaque repeated command', () => {
  it('is refused, says what to use instead, and does not end the turn', async () => {
    const exec = opaqueExecTool();
    const glob = listingTool(() => 'notes.txt');
    let turn = 0;
    const llm = createMockLlm((request) => {
      turn += 1;
      if (turn === 1) return toolCallResponse([{ id: 'exec-1', name: 'exec', args: { command: 'Get-ChildItem .' } }]);
      if (turn === 2) return toolCallResponse([{ id: 'exec-2', name: 'exec', args: { command: 'Get-ChildItem .' } }]);
      // The refusal named a structured tool, so the model switches to it.
      if (turn === 3) {
        const refused = request.messages.some((message) => typeof message.content === 'string'
          && message.content.includes('refusing to replay'));
        expect(refused).toBe(true);
        return toolCallResponse([{ id: 'list-1', name: 'glob', args: { pattern: '*' } }]);
      }
      return textResponse('the directory contains notes.txt');
    });
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [exec, glob], inbound: textMessage('user', '看看目录里有什么') });

    const result = await stage(ctx);

    expect(result, result.error).toMatchObject({ ok: true, next: 'verify' });
    // The command ran exactly once: the repeat never reached the tool.
    expect(exec.calls).toHaveLength(1);
    const refusal = (ctx.toolResults ?? []).find((entry) => /refusing to replay/.test(entry.error ?? ''));
    expect(refusal).toBeDefined();
    expect(String(refusal?.error)).toContain('`glob`');
    // The run survived the refusal and the model got its fresh observation.
    expect(glob.calls).toHaveLength(1);
    expect(ctx.reply).toBe('the directory contains notes.txt');
  });

  it('still refuses a repeated successful write', async () => {
    const write = writerTool(() => undefined);
    const llm = createMockLlm(() => toolCallResponse([{ id: `write-${Math.random()}`, name: 'write', args: { file_path: 'game.html' } }]));
    const stage = createExecuteStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [write], inbound: textMessage('user', '写两次') });

    await stage(ctx);

    expect(write.calls).toHaveLength(1);
    expect((ctx.toolResults ?? []).some((entry) => /refusing to replay/.test(entry.error ?? ''))).toBe(true);
  });
});
