import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_CONFIG } from '../packages/config/src/index.js';
import { DEFAULT_BRANDING } from '../packages/branding/src/index.js';
import { createExecuteStage } from '../packages/harness/src/stages/execute.js';
import { createMockLlm, makeCtx, makeTool, textResponse, toolCallResponse } from '../packages/harness/src/tests/helpers.js';
import { createRunner } from '../packages/runner/src/runner.js';
import { createExecTool } from '../packages/tools/src/builtin/exec.js';
import { bindShellApprovalAuthority } from '../packages/tools/src/shell-authorization.js';
import { ToolExecutionService } from '../packages/tools/src/tool-execution-service.js';
import { ShellRepeatAuthorizationStore } from '../packages/app/src/main/shell-repeat-authorization-store.js';
import { createSideEffectLifecycle } from '../packages/harness/src/stages/execute/side-effect-lifecycle.js';
import type { AgentTool, ToolContext } from '../packages/types/src/agent.js';

const roots: string[] = [];
const runners: Array<{ shutdown(): Promise<void> }> = [];
let originalDataDir: string | undefined;

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.shutdown();
  if (originalDataDir === undefined) delete process.env.LITTLESHEEP_DATA_DIR;
  else process.env.LITTLESHEEP_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

async function tempRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function shellContext(cwd: string, tools: AgentTool[], text: string, authorizeRequest: (count: number) => boolean = () => true) {
  const ctx = makeCtx({ tools, inbound: { role: 'user', content: [{ type: 'text', text }] } as never });
  ctx.cwd = cwd;
  ctx.toolContext.cwd = cwd;
  ctx.toolContext.workspaceRoot = cwd;
  const approve: NonNullable<ToolContext['approve']> = async () => true;
  let approvalRequests = 0;
  bindShellApprovalAuthority(approve, {
    runId: ctx.runId, sessionId: String(ctx.sessionId), workspaceRoot: cwd, workspaceId: `s1b:${ctx.runId}`, permission: 'fixture-only',
    current: async () => `fixture:${cwd}`, decide: () => 'approval', request: async () => { approvalRequests += 1; return authorizeRequest(approvalRequests); },
  });
  ctx.toolContext.approve = approve;
  return { ctx, approvalRequests: () => approvalRequests };
}

function executeScripted(ctx: ReturnType<typeof shellContext>, responses: ReturnType<typeof textResponse>[]) {
  let response = 0;
  return createExecuteStage({
    llm: createMockLlm(() => responses[response++] ?? textResponse('fixture loop complete')),
    model: 'rcd/s1b-scripted-provider', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING,
  })(ctx);
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('RCD S1B Shell invocation and recovery semantics', () => {
  it('F01/B01: fresh Main approval permits the same Shell command after a trusted file change', async () => {
    const cwd = await tempRoot('ls-rcd-s1b-b01-');
    const input = join(cwd, 'input.txt');
    const script = join(cwd, 'check.mjs');
    const log = join(cwd, 'runs.log');
    await writeFile(input, 'v1\n', 'utf8');
    await writeFile(script, "import {appendFileSync,readFileSync} from 'node:fs'; const value=readFileSync('input.txt','utf8').trim(); appendFileSync('runs.log',value+'\\n'); console.log(value);\n", 'utf8');
    const command = 'node check.mjs';
    const changed: Array<{ before: string; after: string }> = [];
    const edit: AgentTool = {
      name: 's1b_fixture_edit', description: 'Change only the B01 temporary input file.',
      inputSchema: z.object({ value: z.string() }).strict(),
      execution: { concurrency: 'exclusive', resources: () => [{ key: 'workspace:input.txt', mode: 'write' }] },
      async execute(value) {
        const before = await readFile(input);
        await writeFile(input, `${(value as { value: string }).value}\n`, 'utf8');
        const after = await readFile(input);
        changed.push({ before: hash(before.toString('utf8')), after: hash(after.toString('utf8')) });
        return { callId: '', ok: true, output: 'temporary file changed' };
      },
    };
    const exec = createExecTool({ interactive: false });
    const { ctx, approvalRequests } = shellContext(cwd, [exec, edit], 'Execute the same local observation around one fixture change.');
    const result = await executeScripted(ctx, [
      toolCallResponse([{ id: 'b01-shell-1', name: 'exec', args: { command, cwd: '.' } }]),
      toolCallResponse([{ id: 'b01-edit', name: edit.name, args: { value: 'v2' } }]),
      toolCallResponse([{ id: 'b01-shell-2', name: 'exec', args: { command, cwd: '.' } }]),
      textResponse('Observed the replay protection result.'),
    ]);
    const actualRuns = (await readFile(log, 'utf8')).trim().split(/\r?\n/u);
    const shellCalls = (ctx.toolInvocations ?? []).filter((call) => call.toolName === 'exec');
    expect(actualRuns).toEqual(['v1', 'v2']);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.before).not.toBe(changed[0]?.after);
    expect(shellCalls.map((call) => call.callId)).toEqual(['b01-shell-1', 'b01-shell-2']);
    expect(shellCalls.map((call) => call.status)).toEqual(['succeeded', 'succeeded']);
    expect(shellCalls[0]?.inputHash).toBe(shellCalls[1]?.inputHash);
    const execEffects = (ctx.sideEffects ?? []).filter((effect) => effect.toolName === 'exec');
    expect(execEffects).toHaveLength(2);
    expect(execEffects[0]).toMatchObject({ status: 'succeeded', callId: 'b01-shell-1', resourceKeys: [], effectKind: 'external' });
    expect(execEffects[1]).toMatchObject({ status: 'succeeded', callId: 'b01-shell-2', resourceKeys: [], effectKind: 'external' });
    expect(execEffects[1]?.idempotencyKey).not.toBe(execEffects[0]?.idempotencyKey);
    expect(execEffects[0]?.reRunnable).not.toBe(true);
    expect(approvalRequests()).toBe(2);
    expect(result.ok).toBe(true);
  });

  it('B02: unchanged state can be re-executed only after a fresh one-shot approval', async () => {
    const cwd = await tempRoot('ls-rcd-s1b-b02-');
    const log = join(cwd, 'runs.log');
    await writeFile(join(cwd, 'check.mjs'), "import {appendFileSync} from 'node:fs'; appendFileSync('runs.log','ran\\n'); console.log('ok');\n", 'utf8');
    const command = 'node check.mjs';
    const exec = createExecTool({ interactive: false });
    const { ctx, approvalRequests } = shellContext(cwd, [exec], 'Execute the identical command twice.');
    const result = await executeScripted(ctx, [
      toolCallResponse([{ id: 'b02-shell-1', name: 'exec', args: { command, cwd: '.' } }]),
      toolCallResponse([{ id: 'b02-shell-2', name: 'exec', args: { command, cwd: '.' } }]),
      textResponse('Second call was refused.'),
    ]);
    expect((await readFile(log, 'utf8')).trim().split(/\r?\n/u)).toEqual(['ran', 'ran']);
    expect((ctx.toolInvocations ?? []).map((call) => call.callId)).toEqual(['b02-shell-1', 'b02-shell-2']);
    expect((ctx.sideEffects ?? []).filter((effect) => effect.toolName === 'exec')).toHaveLength(2);
    expect(approvalRequests()).toBe(2);
    expect(result.ok).toBe(true);
  });

  it('F02: a one-shot Shell grant cannot authorize the next identical call', async () => {
    const cwd = await tempRoot('ls-rcd-s1b-f02-');
    const log = join(cwd, 'runs.log');
    await writeFile(join(cwd, 'check.mjs'), "import {appendFileSync} from 'node:fs'; appendFileSync('runs.log','ran\\n'); console.log('ok');\n", 'utf8');
    const command = 'node check.mjs';
    const exec = createExecTool({ interactive: false });
    const { ctx, approvalRequests } = shellContext(cwd, [exec], 'Run once; ask again for the identical command.', (count) => count === 1);
    await executeScripted(ctx, [
      toolCallResponse([{ id: 'f02-first', name: 'exec', args: { command, cwd: '.' } }]),
      toolCallResponse([{ id: 'f02-second', name: 'exec', args: { command, cwd: '.' } }]),
      textResponse('The second authorization was denied.'),
    ]);
    expect((await readFile(log, 'utf8')).trim().split(/\r?\n/u)).toEqual(['ran']);
    expect(approvalRequests()).toBe(2);
    expect((ctx.toolInvocations ?? []).find((call) => call.callId === 'f02-second')?.status).toBe('approval_denied');
    expect((ctx.sideEffects ?? []).filter((effect) => effect.toolName === 'exec')).toHaveLength(1);
  });

  it('F03: bounded exact-command repeat approval creates fresh effect identities within its scope', async () => {
    const cwd = await tempRoot('ls-rcd-s1b-f03-');
    await writeFile(join(cwd, 'check.mjs'), "import {appendFileSync} from 'node:fs'; appendFileSync('runs.log','run\\n'); console.log('bounded repeat executed');\n", 'utf8');
    const exec = createExecTool({ interactive: false });
    const ctx = makeCtx({ tools: [exec], inbound: { role: 'user', content: [{ type: 'text', text: 'Run the explicitly remembered exact node check.mjs command twice.' }] } as never });
    ctx.cwd = cwd; ctx.toolContext.cwd = cwd; ctx.toolContext.workspaceRoot = cwd;
    const repeatStore = new ShellRepeatAuthorizationStore();
    let approvalRequests = 0;
    const approve: NonNullable<ToolContext['approve']> = async () => true;
    bindShellApprovalAuthority(approve, {
      runId: ctx.runId, sessionId: String(ctx.sessionId), workspaceRoot: cwd, workspaceId: `s1b:${ctx.runId}`, permission: 'fixture-only',
      current: async () => `fixture:${cwd}`, decide: () => 'approval',
      request: async () => { approvalRequests += 1; return { approved: true, rememberShellCommand: true }; },
      consumeRepeatAuthorization: (description) => repeatStore.consume(description),
      rememberRepeatAuthorization: (description) => repeatStore.remember(description),
    });
    ctx.toolContext.approve = approve;
    const command = 'node check.mjs';
    const calls = [1, 2].map((index) => toolCallResponse([{ id: `f03-call-${index}`, name: 'exec', args: { command, cwd: '.' } }]));
    const result = await executeScripted(ctx, [...calls, textResponse('The bounded repeat sequence completed.')]);
    const effects = (ctx.sideEffects ?? []).filter((effect) => effect.toolName === 'exec');
    expect(result.ok).toBe(true);
    expect(effects).toHaveLength(2);
    expect(effects.every((effect) => effect.status === 'succeeded')).toBe(true);
    expect(new Set(effects.map((effect) => effect.idempotencyKey)).size).toBe(2);
    expect(approvalRequests).toBe(1);
    expect((await readFile(join(cwd, 'runs.log'), 'utf8')).trim().split(/\r?\n/u)).toEqual(['run', 'run']);
  });

  it('F05: a new call identity cannot retry an unknown Shell effect', async () => {
    const cwd = await tempRoot('ls-rcd-s1b-f05-');
    const log = join(cwd, 'runs.log');
    await writeFile(join(cwd, 'check.mjs'), "import {appendFileSync} from 'node:fs'; appendFileSync('runs.log','effect\\n'); console.log('effect applied');\n", 'utf8');
    const { ctx } = shellContext(cwd, [], 'Run one Shell effect and retain its uncertain outcome.');
    const exec = createExecTool({ interactive: false });
    const execute = exec.execute!;
    let hostInvocations = 0;
    exec.execute = async (input, toolCtx) => {
      hostInvocations += 1;
      await execute(input, toolCtx);
      throw new Error('injected lost result after actual Shell completion');
    };
    const service = new ToolExecutionService({ registrations: [{ tool: exec, source: 'builtin' }], toolContext: ctx.toolContext });
    const lifecycle = createSideEffectLifecycle(ctx);
    const input = { command: 'node check.mjs', cwd: '.' };
    const first = await service.executeBatch([{ callId: 'f05-call-1', name: 'exec', input }], lifecycle);
    const firstEffect = (ctx.sideEffects ?? []).find((effect) => effect.callId === 'f05-call-1');
    expect(first.get(0)?.ok).toBe(false);
    expect(firstEffect?.status).toBe('unknown');
    expect((await readFile(log, 'utf8')).trim().split(/\r?\n/u)).toEqual(['effect']);

    const second = await service.executeBatch([{ callId: 'f05-call-2', name: 'exec', input }], lifecycle);
    expect(second.get(0)?.error).toContain('unresolved effect');
    expect(hostInvocations).toBe(1);
    expect((await readFile(log, 'utf8')).trim().split(/\r?\n/u)).toEqual(['effect']);
    expect((ctx.sideEffects ?? []).filter((effect) => effect.toolName === 'exec')).toHaveLength(1);
  });

  it('F06: identical no-progress Shell calls remain bounded by the existing tool repeat limit', async () => {
    const cwd = await tempRoot('ls-rcd-s1b-f06-');
    await writeFile(join(cwd, 'check.mjs'), "import {appendFileSync} from 'node:fs'; appendFileSync('runs.log','ran\\n'); console.log('same observation');\n", 'utf8');
    const command = 'node check.mjs';
    const exec = createExecTool({ interactive: false });
    const { ctx } = shellContext(cwd, [exec], 'Repeated no-progress requests must stop within existing Runtime bounds.');
    const repeated = Array.from({ length: 8 }, (_, index) => toolCallResponse([
      { id: `f06-call-${index + 1}`, name: 'exec', args: { command, cwd: '.' } },
    ]));
    await executeScripted(ctx, [...repeated, textResponse('Stop after the Runtime bound.')]);
    const attempts = (await readFile(join(cwd, 'runs.log'), 'utf8')).trim().split(/\r?\n/u);
    expect(attempts.length).toBeLessThanOrEqual(3);
    expect((ctx.loopBudget?.toolLoopIterationsUsed ?? 0)).toBeLessThanOrEqual(ctx.loopBudget?.maxToolLoopIterations ?? Number.MAX_SAFE_INTEGER);
    expect((ctx.toolResults ?? []).length).toBeLessThan(8);
  });

  it('B03: recovery of a successfully settled effect preserves its identity and never executes it again', async () => {
    const root = await tempRoot('ls-rcd-s1b-b03-');
    const dataDir = join(root, 'data');
    const work = join(root, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(work, { recursive: true }));
    originalDataDir ??= process.env.LITTLESHEEP_DATA_DIR;
    process.env.LITTLESHEEP_DATA_DIR = dataDir;
    let executions = 0;
    const targetTool: AgentTool = {
      name: 's1b_confirmed_effect', description: 'Write one file in the isolated workspace.', inputSchema: z.object({}).strict(),
      execution: { concurrency: 'exclusive', resources: () => [{ key: 'fixture:b03-effect', mode: 'write' }] },
      async execute(_input, context) { executions += 1; await writeFile(join(context.cwd, 'effect.txt'), 'committed', 'utf8'); return { callId: '', ok: true, output: 'committed' }; },
    };
    const llm = createMockLlm((request) => {
      const prompt = JSON.stringify(request.messages);
      if (prompt.includes('Choose the next LittleSheep activity')) return textResponse('{"type":"problem","confidence":0.99,"reason":"perform the fixture write"}');
      if (prompt.includes('You are the DECIDE stage')) return textResponse('{"plan":[{"description":"write fixture","tools":["s1b_confirmed_effect"]}]}');
      if (!request.messages.some((message) => message.role === 'tool')) return toolCallResponse([{ id: 'b03-original-call', name: targetTool.name, args: {} }]);
      if (prompt.includes('You are the VERIFY stage')) return textResponse('{"verdict":"pass","reason":"file and settled effect confirmed"}');
      return textResponse('Fixture effect completed.');
    });
    const first = await createRunner({ config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING, model: 'rcd/s1b-scripted-provider', llm, approve: async () => true, skillsDirs: [] });
    runners.push(first);
    const append = first.infra.durableEventStore.append.bind(first.infra.durableEventStore);
    let completionReceiptAttempts = 0;
    vi.spyOn(first.infra.durableEventStore, 'append').mockImplementation(async (event) => {
      if (event.type === 'run_completed' && completionReceiptAttempts++ === 0) throw new Error('injected completion receipt loss after effect settlement');
      return append(event);
    });
    const run = await first.run({ runId: 'rcd-s1b-b03', text: 'Write the fixture file once and verify it.', cwd: work, additionalTools: [targetTool] });
    const before = await first.infra.durableEventStore.read(String(run.sessionId), run.runId);
    const intent = before.find((event) => event.type === 'effect_intent_created');
    const settlement = before.find((event) => event.type === 'effect_settled');
    expect(intent?.payload.effectId).toBe(settlement?.payload.effectId);
    expect(settlement?.payload.status).toBe('succeeded');
    expect(before.some((event) => event.type === 'run_completed')).toBe(false);
    await first.shutdown();
    runners.splice(runners.indexOf(first), 1);
    const restarted = await createRunner({ config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING, model: 'rcd/s1b-scripted-provider', llm: createMockLlm(textResponse('must not execute during recovery')), skillsDirs: [] });
    runners.push(restarted);
    const recovery = await restarted.recoverDurableRun!(run.sessionId, run.runId);
    const recoveryAgain = await restarted.recoverDurableRun!(run.sessionId, run.runId);
    expect(executions).toBe(1);
    expect(recovery.actions.map((action) => action.kind)).toContain('run_completed');
    expect(recoveryAgain.actions).toHaveLength(0);
    expect((await restarted.infra.durableEventStore.read(String(run.sessionId), run.runId)).filter((event) => event.type === 'effect_settled')).toHaveLength(1);
  });

  it('B04: X01 controlled post-effect fault remains unknown and does not replay on recovery', async () => {
    const root = await tempRoot('ls-rcd-s1b-b04-');
    const dataDir = join(root, 'data');
    const work = join(root, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(work, { recursive: true }));
    originalDataDir ??= process.env.LITTLESHEEP_DATA_DIR;
    process.env.LITTLESHEEP_DATA_DIR = dataDir;
    let executions = 0;
    const fault: AgentTool = {
      name: 's1b_unknown_effect', description: 'Write, then inject a controlled settlement fault.', inputSchema: z.object({}).strict(),
      execution: { concurrency: 'exclusive', resources: () => [{ key: 'fixture:b04-effect', mode: 'write' }] },
      async execute(_input, context) { executions += 1; await writeFile(join(context.cwd, 'effect.txt'), 'applied', 'utf8'); throw new Error('injected settlement outcome unknown'); },
    };
    const llm = createMockLlm((request) => {
      const prompt = JSON.stringify(request.messages);
      if (prompt.includes('Choose the next LittleSheep activity')) return textResponse('{"type":"problem","confidence":0.99,"reason":"execute uncertain fixture effect"}');
      if (prompt.includes('You are the DECIDE stage')) return textResponse('{"plan":[{"description":"execute fault fixture","tools":["s1b_unknown_effect"]}]}');
      if (prompt.includes('You are the RECOVER stage')) return textResponse('{"action":"abort","reason":"unknown effect must not replay"}');
      if (prompt.includes('You are the VERIFY stage')) return textResponse('{"verdict":"fail","reason":"effect outcome unknown"}');
      if (!request.messages.some((message) => message.role === 'tool')) return toolCallResponse([{ id: 'b04-original-call', name: fault.name, args: {} }]);
      return textResponse('Stop safely.');
    });
    const first = await createRunner({ config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING, model: 'rcd/s1b-scripted-provider', llm, approve: async () => true, skillsDirs: [] });
    runners.push(first);
    const run = await first.run({ runId: 'rcd-s1b-b04', text: 'Execute one effect that loses its settlement.', cwd: work, additionalTools: [fault] });
    const before = await first.infra.durableEventStore.read(String(run.sessionId), run.runId);
    const unknownSettlement = before.find((event) => event.type === 'effect_settled' && event.payload.status === 'unknown');
    await first.shutdown();
    runners.splice(runners.indexOf(first), 1);
    const restarted = await createRunner({ config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING, model: 'rcd/s1b-scripted-provider', llm: createMockLlm(textResponse('must not execute during recovery')), skillsDirs: [] });
    runners.push(restarted);
    const recovery = await restarted.recoverDurableRun!(run.sessionId, run.runId);
    expect((await readFile(join(work, 'effect.txt'), 'utf8'))).toBe('applied');
    expect(executions).toBe(1);
    expect(unknownSettlement?.payload).toMatchObject({ status: 'unknown', errorHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(recovery.projection.unknownEffectIds).toHaveLength(1);
    expect(recovery.actions).not.toContainEqual(expect.objectContaining({ kind: 'effect_settled' }));
    expect((await restarted.infra.durableEventStore.read(String(run.sessionId), run.runId)).filter((event) => event.type === 'effect_settled')).toHaveLength(1);
  });

  it('B05: denial, one-shot approval, and pre-aborted invocation cannot create extra Shell effects', async () => {
    const cwd = await tempRoot('ls-rcd-s1b-b05-');
    const target = join(cwd, 'effects.log');
    const command = "node -e \"require('node:fs').appendFileSync('effects.log','run\\n')\"";
    const deniedTool = createExecTool({ interactive: false });
    const deniedCtx = makeCtx({ tools: [deniedTool], inbound: { role: 'user', content: [{ type: 'text', text: 'Try the denied command twice.' }] } as never });
    deniedCtx.cwd = cwd; deniedCtx.toolContext.cwd = cwd; deniedCtx.toolContext.workspaceRoot = cwd;
    let deniedRequests = 0;
    const deny: NonNullable<ToolContext['approve']> = async () => false;
    bindShellApprovalAuthority(deny, { runId: deniedCtx.runId, sessionId: String(deniedCtx.sessionId), workspaceRoot: cwd, workspaceId: `s1b:${deniedCtx.runId}`, permission: 'fixture-only', current: async () => `fixture:${cwd}`, decide: () => 'approval', request: async () => { deniedRequests += 1; return false; } });
    deniedCtx.toolContext.approve = deny;
    await executeScripted(deniedCtx, [toolCallResponse([{ id: 'b05-denied-1', name: 'exec', args: { command, cwd: '.' } }]), textResponse('The request was denied.')]);
    const deniedCtx2 = makeCtx({ tools: [deniedTool], inbound: { role: 'user', content: [{ type: 'text', text: 'Try the same command in a new logical invocation.' }] } as never });
    deniedCtx2.cwd = cwd; deniedCtx2.toolContext.cwd = cwd; deniedCtx2.toolContext.workspaceRoot = cwd;
    bindShellApprovalAuthority(deny, { runId: deniedCtx2.runId, sessionId: String(deniedCtx2.sessionId), workspaceRoot: cwd, workspaceId: `s1b:${deniedCtx2.runId}`, permission: 'fixture-only', current: async () => `fixture:${cwd}`, decide: () => 'approval', request: async () => { deniedRequests += 1; return false; } });
    deniedCtx2.toolContext.approve = deny;
    await executeScripted(deniedCtx2, [toolCallResponse([{ id: 'b05-denied-2', name: 'exec', args: { command, cwd: '.' } }]), textResponse('The new request was denied.')]);

    const scopedTool = createExecTool({ interactive: false });
    const scopedCtx = makeCtx({ tools: [scopedTool], inbound: { role: 'user', content: [{ type: 'text', text: 'Try one authorized command and a different command.' }] } as never });
    scopedCtx.cwd = cwd; scopedCtx.toolContext.cwd = cwd; scopedCtx.toolContext.workspaceRoot = cwd;
    let scopeRequests = 0;
    const scopedApprove: NonNullable<ToolContext['approve']> = async () => true;
    bindShellApprovalAuthority(scopedApprove, { runId: scopedCtx.runId, sessionId: String(scopedCtx.sessionId), workspaceRoot: cwd, workspaceId: `s1b:${scopedCtx.runId}`, permission: 'fixture-only', current: async () => `fixture:${cwd}`, decide: () => 'approval', request: async () => ++scopeRequests === 1 });
    scopedCtx.toolContext.approve = scopedApprove;
    const firstCommand = "node -e \"require('node:fs').appendFileSync('effects.log','allowed\\n')\"";
    const secondCommand = "node -e \"require('node:fs').appendFileSync('effects.log','forbidden\\n')\"";
    await executeScripted(scopedCtx, [toolCallResponse([{ id: 'b05-approved', name: 'exec', args: { command: firstCommand, cwd: '.' } }]), toolCallResponse([{ id: 'b05-new-scope', name: 'exec', args: { command: secondCommand, cwd: '.' } }]), textResponse('Second command was denied.')]);
    const contents = await readFile(target, 'utf8').catch(() => '');
    expect(deniedRequests).toBe(2);
    expect((deniedCtx.toolInvocations ?? []).filter((call) => call.status === 'approval_denied')).toHaveLength(1);
    expect((deniedCtx2.toolInvocations ?? []).filter((call) => call.status === 'approval_denied')).toHaveLength(1);
    expect(scopeRequests).toBe(2);
    expect(contents).toBe('allowed\n');
    expect((scopedCtx.toolInvocations ?? []).find((call) => call.callId === 'b05-new-scope')?.status).toBe('approval_denied');
    expect((scopedCtx.sideEffects ?? []).filter((effect) => effect.toolName === 'exec')).toHaveLength(1);

    const abortedTool = createExecTool({ interactive: false });
    const { ctx: abortedCtx } = shellContext(cwd, [abortedTool], 'The run is already cancelled.');
    abortedCtx.signal = AbortSignal.abort();
    const cancelledCommand = "node -e \"require('node:fs').appendFileSync('effects.log','cancelled\\n')\"";
    await executeScripted(abortedCtx, [toolCallResponse([{ id: 'b05-cancelled', name: 'exec', args: { command: cancelledCommand, cwd: '.' } }]), textResponse('Cancelled before execution.')]);
    expect(await readFile(target, 'utf8')).toBe('allowed\n');
    expect((abortedCtx.toolInvocations ?? []).find((call) => call.callId === 'b05-cancelled')?.status).toBe('aborted');
  });
});
