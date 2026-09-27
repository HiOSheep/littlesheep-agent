#!/usr/bin/env node
// Experiment entry for `docs/taskbooks/runtime-autonomy-sandbox-evaluation-taskbook-2026-09-27.md`.
//
// Three modes, as section 6 requires — a no-cost deterministic precheck, an explicit real-model mode, and a
// sandbox mode — and one append-only per-run ledger with the section-8 minimum field set.
//
//   node scripts/experiment-autonomy-sandbox.mjs budget
//   node scripts/experiment-autonomy-sandbox.mjs precheck [--json=<path>]
//   node scripts/experiment-autonomy-sandbox.mjs model --case=RT-01 --arm=A --trial=1 --batch=<id>
//   node scripts/experiment-autonomy-sandbox.mjs sandbox --case=sb04-boundary [--json=<path>]
//
// Every run gets its own data root and workspace under the evidence directory, so no run reads a real
// session, the user's memory tree, or a production credential. The Provider key is read from the process
// environment by name only; it is never written into the ledger, a report, or a child command line.
//
// Exit codes: 0 = every check passed, 1 = at least one acceptance check failed, 2 = usage/config error,
// 3 = blocked (a required capability or input is missing), 4 = budget stop condition reached.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { DEFAULT_BRANDING } from '../packages/branding/dist/index.js';
import { DEFAULT_CONFIG } from '../packages/config/dist/index.js';
import { createLlmClient } from '../packages/llm/dist/index.js';
import { assessRetrievalIntent, renderRetrievalIntentContract, toolsForRetrievalIntent } from '../packages/harness/dist/retrieval-intent.js';
import { classifyToolFailure, toolRoundFailurePolicy } from '../packages/harness/dist/stages/execute/tool-failure-disposition.js';
import { beginSideEffect, describeSideEffect, settlementForResult } from '../packages/harness/dist/stages/execute/side-effect-ledger.js';
import { createRunner } from '../packages/runner/dist/runner.js';
import {
  appendJsonLine, armFingerprint, assertLedgerRecord, configDigest, ensureDir, ledgerRecord,
  readJsonLines, redactConfig, sha256, sourceDigest, writeJson,
} from './lib/experiment-ledger.mjs';
import { RETRIEVAL_PROBES, URL_POLICY_PROBES, fixtureFor, promptHash } from './lib/experiment-fixtures.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * The batch budget and stop conditions, frozen before the first Provider call (taskbook EV-00).
 * Changing any value here starts a new batch with its own id; it never edits this one retroactively.
 */
export const BUDGET = Object.freeze({
  batchId: 'RASB-2026-09-27',
  provider: 'deepseek',
  model: 'deepseek/deepseek-flash',
  reasoning: 'auto',
  maxModelCallsPerRun: 32,
  maxRecoveryAttempts: 3,
  runWallClockMs: 300_000,
  trialsPerArmPerCase: 3,
  realModelRunsPlanned: 24,
  combinationalRunsPlanned: 6,
  maxTotalTokens: 4_000_000,
  maxTotalRuns: 40,
  stopConditions: [
    'total recorded runs reaches maxTotalRuns',
    'total recorded prompt+completion tokens reach maxTotalTokens',
    'a single run exceeds runWallClockMs (recorded as timeout, not retried to success)',
    'the Provider reports a transport failure that survives its own bounded retries (recorded, batch continues)',
    'a fixture precondition fails at setup (recorded blocked, the case stops for that arm)',
  ],
  pricing: {
    status: 'unknown',
    reason: 'no price table is configured in this repository or data root; section 5 requires unknown rather than zero',
  },
});

const EVIDENCE_ROOT = process.env.LS_EXPERIMENT_EVIDENCE_DIR
  ?? 'D:\\littlesheep-evidence\\RASB-2026-09-27';

function parseArgs(argv) {
  const args = { mode: undefined, json: undefined, cases: [] };
  for (const raw of argv) {
    if (!raw.startsWith('--')) {
      args.mode ??= raw;
      continue;
    }
    const [key, value] = raw.slice(2).split('=');
    if (key === 'case') args.cases.push(value);
    else args[key] = value ?? true;
  }
  return args;
}

function ledgerPath(args) {
  return args.ledger ?? join(EVIDENCE_ROOT, 'ledger.jsonl');
}

function out(args, payload, exitCode) {
  if (args.json) writeJson(args.json, payload);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (exitCode !== undefined) process.exitCode = exitCode;
}

async function gitFacts() {
  const run = async (...cmd) => {
    try {
      const { stdout } = await execFileAsync(cmd[0], cmd.slice(1), { cwd: REPO_ROOT, windowsHide: true });
      return stdout.trim();
    } catch (error) {
      return `<failed: ${error.message.split('\n')[0]}>`;
    }
  };
  return {
    head: await run('git', 'rev-parse', 'HEAD'),
    status: await run('git', 'status', '--porcelain=v1'),
    branch: await run('git', 'rev-parse', '--abbrev-ref', 'HEAD'),
  };
}

// ──────────────────────────────────────────────────────────────────────────────── budget

function printBudget() {
  out({}, {
    batchId: BUDGET.batchId,
    writtenAt: new Date().toISOString(),
    ...BUDGET,
    note: 'This budget is frozen before the first Provider call. Superpowers: no run may silently raise it.',
  }, 0);
}

// ──────────────────────────────────────────────────────────────────────────────── shared

function isolatedConfig(overrides = {}) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.agents.defaults.model = BUDGET.model;
  config.agents.defaults.reasoning = BUDGET.reasoning;
  config.agents.defaults.maxModelCallsPerRun = BUDGET.maxModelCallsPerRun;
  config.agents.defaults.maxRecoveryAttempts = BUDGET.maxRecoveryAttempts;
  config.agents.defaults.timeoutSeconds = Math.ceil(BUDGET.runWallClockMs / 1000);
  config.providers = [{
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    // The key stays an environment reference: the isolated data root never stores a value.
    apiKey: '$DEEPSEEK_API_KEY',
    models: ['deepseek-flash'],
  }];
  return Object.assign(config, overrides);
}

async function writeFixture(workspace, fixture) {
  for (const [path, content] of Object.entries(fixture.files)) {
    const target = join(workspace, path);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

async function withWallClock(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ __timedOut: true }), ms);
    timer.unref?.();
  });
  const outcome = await Promise.race([promise, timeout]);
  clearTimeout(timer);
  if (outcome && outcome.__timedOut) {
    await onTimeout?.();
    return { timedOut: true };
  }
  return { timedOut: false, value: outcome };
}

/**
 * The fault injector for RT-02. It rewrites the FIRST proposal of one named tool at the boundary between
 * the model's response and the Runtime's execution — the "execution boundary" the taskbook names — and
 * records the original proposal next to the transformed input. Arm A and arm B get the identical injector,
 * so a difference between them is the rule under test and not the fault.
 */
function createInjector(plan) {
  const state = { applied: null, attempts: 0 };
  const rewrite = (response) => {
    if (!plan || state.applied) return response;
    const index = response.toolCalls?.findIndex((call) => call.function.name === plan.matchTool) ?? -1;
    if (index < 0) return response;
    const call = response.toolCalls[index];
    const original = call.function.arguments ?? '';
    let transformed = original;
    if (plan.kind === 'input_validation') {
      let parsed;
      try { parsed = JSON.parse(original || '{}'); } catch { parsed = {}; }
      parsed[plan.field ?? 'command'] = plan.value ?? 42;
      transformed = JSON.stringify(parsed);
    } else if (plan.kind === 'unknown_tool') {
      call.function.name = 'experiment_unknown_tool';
    }
    state.applied = {
      callId: call.id,
      tool: plan.matchTool,
      kind: plan.kind,
      originalProposal: original,
      transformedProposal: transformed,
      transformedArgumentsHash: sha256(transformed),
    };
    call.function.arguments = transformed;
    return response;
  };
  return {
    state,
    wrap(client) {
      if (!plan) return client;
      return {
        ...client,
        chat: async (req) => rewrite(await client.chat(req)),
        chatStream: async (req, onDelta) => rewrite(await client.chatStream(req, onDelta)),
        embed: client.embed.bind(client),
      };
    },
  };
}

function summarizeRun(result, toolEvents) {
  const invocations = result?.toolInvocations ?? [];
  const webTools = new Set(['web_search', 'web_fetch']);
  const refusals = invocations
    .filter((record) => record.status && record.status !== 'succeeded' && record.status !== 'running' && record.status !== 'proposed')
    .map((record) => ({
      callId: record.callId,
      tool: record.toolName,
      status: record.status,
      reason: (record.error ?? record.errorKind ?? '').slice(0, 240),
    }));
  const permissionPrompts = invocations.filter((record) => record.approval?.required === true);
  return {
    status: result?.status ?? 'error',
    error: result?.error ? String(result.error).slice(0, 400) : null,
    iterations: result?.trace?.filter((stage) => stage.name === 'execute').length ?? null,
    toolCallCount: toolEvents.filter((event) => event.type === 'tool_end').length,
    toolNames: [...new Set(toolEvents.filter((event) => event.type === 'tool_end').map((event) => event.name))],
    webToolEvents: toolEvents.filter((event) => event.type === 'tool_end' && webTools.has(event.name)).map((event) => ({
      name: event.name,
      callId: event.callId,
      ok: event.ok === true,
      error: String(event.error ?? '').slice(0, 200),
    })),
    invocations: invocations.map((record) => ({
      callId: record.callId,
      tool: record.toolName,
      status: record.status,
      errorKind: record.errorKind ?? null,
      inputHash: record.inputHash ?? null,
      resourceKeys: record.resourceKeys ?? null,
      approvalRequired: record.approval?.required ?? 'unknown',
      approvalDecision: record.approval?.decision ?? 'unknown',
      durationMs: record.durationMs ?? null,
    })),
    refusals,
    permissionPromptCount: permissionPrompts.length,
    sideEffects: (result?.sideEffects ?? []).map((effect) => ({
      idempotencyKey: effect.idempotencyKey,
      toolName: effect.toolName,
      status: effect.status,
      resourceKeys: effect.resourceKeys ?? [],
      evidenceRef: effect.evidenceRef ?? null,
    })),
    webEvidencePresent: Boolean(result?.webEvidence && (result.webEvidence.sources?.length ?? 0) > 0),
    reply: String(result?.reply ?? ''),
    durationMs: result?.durationMs ?? null,
  };
}

// ──────────────────────────────────────────────────────────────────────────────── precheck

function makeCtx(overrides = {}) {
  return { runId: 'precheck', sessionId: 'precheck', toolInvocations: [], sideEffects: [], ...overrides };
}

/**
 * RT-02's deterministic contract: which failures the main loop may let the model correct. Each row is a
 * recorded fact the Runtime produced, not an error string it parsed.
 */
function rt02ContractRows() {
  const rows = [
    {
      id: 'input_validation',
      result: { callId: 'c1', ok: false, error: 'tool input validation failed: Expected string, received number' },
      ctx: makeCtx({
        toolInvocations: [{ callId: 'c1', toolName: 'exec', status: 'validation_failed', errorKind: 'input_validation', inputHash: 'h1' }],
      }),
      expectA: 'authoritative',
      expectB: 'correctable',
    },
    {
      id: 'step_tool_not_allowed',
      result: { callId: 'c2', ok: false, error: 'tool is registered but not admitted for the current request: web_search' },
      ctx: makeCtx({
        toolInvocations: [{ callId: 'c2', toolName: 'web_search', status: 'validation_failed', errorKind: 'step_tool_not_allowed', inputHash: 'h2' }],
      }),
      expectA: 'authoritative',
      expectB: 'authoritative',
    },
    {
      id: 'parallel_step_contract',
      result: { callId: 'c3', ok: false, error: 'parallel step s1 exceeded its resource envelope at fs:x' },
      ctx: makeCtx({
        toolInvocations: [{ callId: 'c3', toolName: 'write', status: 'validation_failed', errorKind: 'parallel_step_contract', inputHash: 'h3' }],
      }),
      expectA: 'authoritative',
      expectB: 'authoritative',
    },
    {
      id: 'unknown_tool',
      result: { callId: 'c4', ok: false, error: 'unknown tool: nope' },
      ctx: makeCtx({
        toolInvocations: [{ callId: 'c4', toolName: 'nope', status: 'unknown_tool', errorKind: 'unknown_tool', inputHash: 'h4' }],
      }),
      expectA: 'authoritative',
      expectB: 'authoritative',
    },
    {
      id: 'approval_denied',
      result: { callId: 'c5', ok: false, error: 'denied by approval gate' },
      ctx: makeCtx({
        toolInvocations: [{ callId: 'c5', toolName: 'exec', status: 'approval_denied', errorKind: 'approval_denied', inputHash: 'h5' }],
      }),
      expectA: 'authoritative',
      expectB: 'authoritative',
    },
    {
      id: 'hard_denied',
      result: { callId: 'c6', ok: false, error: 'blocked by runtime safety policy' },
      ctx: makeCtx({
        toolInvocations: [{ callId: 'c6', toolName: 'exec', status: 'hard_denied', errorKind: 'hard_deny', inputHash: 'h6' }],
      }),
      expectA: 'authoritative',
      expectB: 'authoritative',
    },
    {
      id: 'unsettled_effect',
      result: { callId: 'c7', ok: false, error: 'command timed out after 1000ms' },
      ctx: makeCtx({
        toolInvocations: [{ callId: 'c7', toolName: 'exec', status: 'timed_out', errorKind: undefined, inputHash: 'h7' }],
        sideEffects: [{ callId: 'c7', idempotencyKey: 'tool:exec:h7', status: 'in_progress', toolName: 'exec', resourceKeys: [] }],
      }),
      expectA: 'authoritative',
      expectB: 'authoritative',
    },
    {
      id: 'determinate_failure',
      result: { callId: 'c8', ok: false, error: 'exit code 1' },
      ctx: makeCtx({
        toolInvocations: [{ callId: 'c8', toolName: 'exec', status: 'failed', errorKind: undefined, inputHash: 'h8' }],
        sideEffects: [{ callId: 'c8', idempotencyKey: 'tool:exec:h8', status: 'failed', toolName: 'exec', resourceKeys: [] }],
      }),
      expectA: 'correctable',
      expectB: 'correctable',
    },
    {
      id: 'replay_refusal',
      result: { callId: 'c9', ok: false, error: 'side effect already recorded as succeeded; refusing to replay' },
      ctx: makeCtx({
        toolInvocations: [{ callId: 'c9', toolName: 'exec', status: 'repeated_call_blocked', errorKind: 'side_effect_replay', inputHash: 'h9' }],
        sideEffects: [{ callId: 'c9', idempotencyKey: 'tool:exec:h9', status: 'succeeded', toolName: 'exec', resourceKeys: [] }],
      }),
      expectA: 'correctable',
      expectB: 'correctable',
    },
  ];
  return rows.map((row) => {
    const classification = classifyToolFailure(row.ctx, row.result);
    const policy = toolRoundFailurePolicy(row.ctx, [row.result], { boundaryFailure: 'B', effectfulFailure: 'E' });
    return {
      id: row.id,
      classified: classification.disposition,
      reason: classification.reason,
      effectful: classification.effectful,
      forceFinalResponse: policy.forceFinalResponse,
      expectedFrozenA: row.expectA,
      contractHoldsForA: classification.disposition === row.expectA,
    };
  });
}

/**
 * RT-03's deterministic ledger contract, exercised directly on the Runtime's own decision function.
 *
 * The ledger copies its projection on every write (`replaceSideEffectEvidence` detaches the records), so
 * this fixture always reads the ledger back through the context instead of holding an array reference.
 */
async function rt03LedgerRows() {
  const durableEvents = [];
  let effects = [];
  const ctx = {
    runId: 'precheck',
    sessionId: 'precheck',
    get sideEffects() { return effects; },
    set sideEffects(value) { effects = value; },
    appendDurableEvent: async (event) => { durableEvents.push(event); },
  };
  const seed = (effect) => { effects = [...effects, effect]; };
  const settle = (key, status, patch = {}) => {
    effects = effects.map((effect) => (effect.idempotencyKey === key ? { ...effect, status, ...patch } : effect));
  };
  const rows = [];
  const push = (id, outcome, note) => rows.push({ id, ...outcome, note });
  const resourceKey = 'fs:d:\\fixture\\src\\subject.mjs';
  const base = {
    toolName: 'exec',
    callId: 'c1',
    inputHash: 'ih1',
    resourceKeys: [resourceKey],
    effectKind: 'local_mutation',
    reRunnable: true,
  };

  // 1. A fresh operation starts.
  const begun = await beginSideEffect(ctx, { ...base, idempotencyKey: 'tool:exec:ih1' });
  settle('tool:exec:ih1', 'succeeded');
  push('first_execution_starts', { kind: begun.kind }, 'a fresh operation has no prior attempt');

  // 2. The same call again with nothing in between is still a replay.
  const replay = await beginSideEffect(ctx, { ...base, idempotencyKey: 'tool:exec:ih1' });
  push('identical_call_is_replay', { kind: replay.kind, reason: replay.reason ?? null },
    replay.kind === 'duplicate' ? 'refused as the same operation' : `unexpected ${replay.kind}`);

  // 3. A later settled change on the same write resource: a new execution identity.
  seed({
    idempotencyKey: 'tool:write:ih2', toolName: 'write', status: 'succeeded',
    resourceKeys: [resourceKey], effectKind: 'local_mutation',
  });
  const warranted = await beginSideEffect(ctx, { ...base, idempotencyKey: 'tool:exec:ih1' });
  push('repeat_after_recorded_change', {
    kind: warranted.kind,
    newKey: warranted.descriptor?.idempotencyKey ?? null,
    evidenceRef: warranted.descriptor?.evidenceRef ?? null,
  }, warranted.kind === 'started' && warranted.descriptor?.idempotencyKey === 'tool:exec:ih1:retry1'
    ? 'a new attempt identity was issued and the earlier settlement stays in the record'
    : 'no distinct new identity');

  // 4. in_progress and unknown never qualify.
  seed({ idempotencyKey: 'tool:exec:ih3', toolName: 'exec', status: 'in_progress', resourceKeys: [resourceKey], effectKind: 'local_mutation' });
  const inProgress = await beginSideEffect(ctx, { ...base, idempotencyKey: 'tool:exec:ih3' });
  push('in_progress_is_blocked', { kind: inProgress.kind, reason: inProgress.reason ?? null },
    inProgress.kind === 'blocked' ? 'an unprovable state is not replayed' : `unexpected ${inProgress.kind}`);

  seed({ idempotencyKey: 'tool:exec:ih4', toolName: 'exec', status: 'unknown', resourceKeys: [resourceKey], effectKind: 'local_mutation' });
  const unknown = await beginSideEffect(ctx, { ...base, idempotencyKey: 'tool:exec:ih4' });
  push('unknown_is_blocked', { kind: unknown.kind, reason: unknown.reason ?? null },
    unknown.kind === 'blocked' ? 'an unknown state is not replayed' : `unexpected ${unknown.kind}`);

  // 5. An opaque tool that declares no re-runnable capability keeps the replay refusal after a change.
  const opaque = await beginSideEffect(ctx, { ...base, reRunnable: false, idempotencyKey: 'tool:exec:ih1' });
  push('opaque_tool_keeps_refusal', { kind: opaque.kind },
    opaque.kind === 'duplicate' ? 'the declared capability is what opens the warrant' : `unexpected ${opaque.kind}`);

  // 6. A concurrent lease conflict is reported as blocked, not replayed.
  const leasedCtx = {
    ...ctx,
    effectLeases: { acquire: async () => ({ kind: 'conflict', leaseUntil: '2026-09-27T00:00:00.000Z' }) },
  };
  const conflicted = await beginSideEffect(leasedCtx, { ...base, idempotencyKey: 'tool:exec:ih9', callId: 'c9' });
  push('lease_conflict_is_blocked', { kind: conflicted.kind, reason: conflicted.reason ?? null },
    conflicted.kind === 'blocked' ? 'another worker owns the effect' : `unexpected ${conflicted.kind}`);

  // 7. A settled failure is a new attempt, not a replay.
  seed({ idempotencyKey: 'tool:exec:ih5', toolName: 'exec', status: 'failed', resourceKeys: [resourceKey], effectKind: 'local_mutation' });
  const retry = await beginSideEffect(ctx, { ...base, idempotencyKey: 'tool:exec:ih5' });
  push('settled_failure_retries', { kind: retry.kind, newKey: retry.descriptor?.idempotencyKey ?? null },
    'a determinate failure may be attempted again');

  // 8. Settlement classification: a synthesized status is unknown, a reported one is determinate.
  push('settlement_for_thrown_result', {
    kind: settlementForResult({ callId: 'x', ok: false, error: 'boom' }, { status: 'failed' }),
  }, 'a cut-short invocation stays unknown');
  push('settlement_for_returned_failure', {
    kind: settlementForResult({ callId: 'x', ok: false, error: 'exit code 1' }),
  }, 'a returned failure is determinate');

  return rows.map((row) => ({ ...row, durableEventCount: durableEvents.length }));
}

/**
 * The RT-03 gap, measured on the real `exec` registration rather than on a synthetic descriptor: what the
 * Runtime can describe about a real shell command today.
 */
async function rt03ExecDescriptorRow() {
  const tools = await import('../packages/tools/dist/index.js');
  const execTool = tools.execTool ?? tools.createExecTool?.({ interactive: false });
  if (!execTool) return { id: 'exec_descriptor', available: false, note: 'execTool is not exported from @littlesheep/tools' };
  const input = { command: 'node tools/run_tests.mjs', cwd: 'D:\\fixture', timeout_ms: 120000 };
  const resources = typeof execTool.execution?.resources === 'function'
    ? execTool.execution.resources(input, { sessionId: 'precheck', runId: 'precheck', cwd: 'D:\\fixture' })
    : [];
  const descriptor = describeSideEffect(execTool, input, resources, undefined, 'c1');
  return {
    id: 'exec_descriptor',
    available: true,
    declaredReRunnable: execTool.reRunnableAfterResourceChange === true,
    resolvedResources: resources,
    descriptor: descriptor
      ? {
        idempotencyKey: descriptor.idempotencyKey,
        resourceKeys: descriptor.resourceKeys,
        effectKind: descriptor.effectKind,
        reRunnable: descriptor.reRunnable === true,
      }
      : null,
    note: descriptor
      ? 'exec is recorded as an opaque external effect: no write resources, so no resource-change warrant can ever open'
      : 'exec resolves no side-effect descriptor at all',
  };
}

/** RT-04's deterministic guard: the fourth identical read of a file whose content keeps changing. */
async function rt04ContractRow() {
  const { ToolExecutionService } = await import('../packages/tools/dist/index.js');
  const versions = ['v1', 'v2', 'v3', 'v4', 'v5'];
  let call = 0;
  const tool = {
    name: 'read',
    description: 'probe',
    inputSchema: { parse: (value) => value },
    execution: { concurrency: 'parallel', resources: () => [{ key: 'fs:probe', mode: 'read' }] },
    async execute() {
      const output = versions[Math.min(call, versions.length - 1)];
      call += 1;
      return { ok: true, output };
    },
  };
  const service = new ToolExecutionService({
    registrations: [{ tool, source: 'builtin' }],
    toolContext: { sessionId: 'precheck', runId: 'precheck', cwd: process.cwd() },
    maxRepeat: 3,
  });
  const statuses = [];
  for (let index = 0; index < 5; index += 1) {
    const results = await service.executeBatch([{ callId: `r${index}`, name: 'read', input: { file_path: 'probe.txt' } }]);
    const record = service.snapshot().records.at(-1);
    statuses.push({ attempt: index + 1, ok: results.get(0)?.ok === true, status: record?.status, errorKind: record?.errorKind ?? null });
  }
  return {
    id: 'identical_read_four_times',
    statuses,
    fourthBlocked: statuses[3]?.ok === false,
    fifthBlocked: statuses[4]?.ok === false,
    note: 'the guard counts (tool, parsed input) occurrences, not the resource version the call observed',
  };
}

async function probeProvider() {
  const keyName = 'DEEPSEEK_API_KEY';
  const value = process.env[keyName];
  if (!value) return { usable: false, reason: `${keyName} is not present in this process environment` };
  const started = performance.now();
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${value}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'reply with the single word: ok' }],
        max_tokens: 8,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json().catch(() => undefined);
    return {
      usable: response.ok,
      httpStatus: response.status,
      elapsedMs: Math.round(performance.now() - started),
      usage: body?.usage ?? null,
      errorMessage: body?.error?.message ? String(body.error.message).slice(0, 200) : null,
    };
  } catch (error) {
    return { usable: false, reason: `transport error: ${error?.name}: ${error?.message}`, elapsedMs: Math.round(performance.now() - started) };
  }
}

async function runPrecheck(args) {
  const started = performance.now();
  const [git, source, arm] = [await gitFacts(), sourceDigest(REPO_ROOT), armFingerprint(REPO_ROOT)];

  // 1. Retrieval admission probes (deterministic, no model).
  const intentRows = RETRIEVAL_PROBES.map((probe) => {
    const assessment = assessRetrievalIntent(probe.text);
    const admittedTools = toolsForRetrievalIntent({
      classification: { retrievalIntent: assessment.intent },
      inbound: { content: [{ type: 'text', text: probe.text }] },
      tools: [{ name: 'read' }, { name: 'web_search' }, { name: 'web_fetch' }],
      toolSources: { read: 'builtin', web_search: 'builtin', web_fetch: 'builtin' },
    }).map((tool) => tool.name);
    const webAdmitted = admittedTools.includes('web_search') || admittedTools.includes('web_fetch');
    const row = {
      id: probe.id,
      kind: probe.kind,
      text: probe.text,
      intent: assessment.intent,
      reason: assessment.reason,
      webAdmitted,
      contract: renderRetrievalIntentContract({
        classification: { retrievalIntent: assessment.intent },
        inbound: { content: [{ type: 'text', text: probe.text }] },
      }),
    };
    if (probe.kind === 'frozen') {
      row.frozenIntent = probe.frozenIntent;
      row.frozenAdmission = probe.frozenAdmission;
      row.intentMatchesFrozen = assessment.intent === probe.frozenIntent;
      row.admissionMatchesFrozen = (probe.frozenAdmission === 'admitted') === webAdmitted;
      return row;
    }
    row.requirement = probe.requirement;
    row.requiredAdmission = probe.requiredAdmission;
    row.requirementHolds = probe.requiredAdmission === 'either' ? true : (probe.requiredAdmission === 'admitted') === webAdmitted;
    return row;
  });

  // 1b. URL-layer negatives: these must be refused before any outbound request exists.
  const webPolicy = await import('../packages/web/dist/index.js');
  const urlRows = URL_POLICY_PROBES.map((probe) => {
    let blocked = false;
    let errorKind = null;
    try {
      const canonical = webPolicy.canonicalizeHttpUrl(probe.url);
      if (webPolicy.hasSensitiveUrlParameters(canonical)) {
        blocked = true;
        errorKind = 'web_sensitive_query';
      }
    } catch (error) {
      blocked = true;
      errorKind = error?.kind ?? error?.code ?? 'canonicalize_rejected';
    }
    return {
      id: probe.id,
      url: probe.url,
      note: probe.note,
      expectBlocked: probe.expectBlocked,
      blockedAtSyntaxLayer: blocked,
      errorKind,
      matchesExpectation: blocked === probe.expectBlocked || (!probe.expectBlocked && !blocked),
    };
  });
  // The address layer runs without DNS by using literal addresses and an injected resolver.
  for (const row of urlRows) {
    if (row.blockedAtSyntaxLayer || !row.expectBlocked) continue;
    try {
      await webPolicy.validatePublicUrl(row.url, { resolveHost: async () => { throw new Error('no dns during precheck'); } });
      row.blockedAtAddressLayer = false;
    } catch (error) {
      row.blockedAtAddressLayer = true;
      row.errorKind = error?.kind ?? error?.code ?? row.errorKind;
    }
    row.matchesExpectation = row.blockedAtAddressLayer === true;
  }

  const [rt02, rt03, rt03Exec, rt04, provider] = [
    rt02ContractRows(),
    await rt03LedgerRows(),
    await rt03ExecDescriptorRow(),
    await rt04ContractRow(),
    await probeProvider(),
  ];

  const row = (id) => rt03.find((entry) => entry.id === id) ?? {};
  const frozenRows = intentRows.filter((entry) => entry.kind === 'frozen');
  const requirementRows = intentRows.filter((entry) => entry.kind === 'requirement');
  const brokenRequirements = requirementRows.filter((entry) => !entry.requirementHolds);
  const urlMismatches = urlRows.filter((entry) => !entry.matchesExpectation);

  const checks = [
    { id: 'intent_probes_match_frozen_table', pass: frozenRows.every((entry) => entry.intentMatchesFrozen), detail: frozenRows.filter((entry) => !entry.intentMatchesFrozen).map((entry) => entry.id) },
    { id: 'frozen_admission_table_reproduced', pass: frozenRows.every((entry) => entry.admissionMatchesFrozen), detail: frozenRows.filter((entry) => !entry.admissionMatchesFrozen).map((entry) => entry.id) },
    { id: 'url_policy_matrix_holds', pass: urlMismatches.length === 0, detail: urlMismatches.map((entry) => entry.id) },
    { id: 'rt02_contract_matches_current_implementation', pass: rt02.every((entry) => entry.contractHoldsForA), detail: rt02.filter((entry) => !entry.contractHoldsForA).map((entry) => entry.id) },
    { id: 'rt03_identical_call_is_a_replay', pass: row('identical_call_is_replay').kind === 'duplicate', detail: row('identical_call_is_replay') },
    { id: 'rt03_recorded_change_issues_a_new_identity', pass: row('repeat_after_recorded_change').kind === 'started', detail: row('repeat_after_recorded_change') },
    { id: 'rt03_unprovable_states_are_blocked', pass: row('in_progress_is_blocked').kind === 'blocked' && row('unknown_is_blocked').kind === 'blocked', detail: [row('in_progress_is_blocked'), row('unknown_is_blocked')] },
    { id: 'rt03_opaque_tool_keeps_the_refusal', pass: row('opaque_tool_keeps_refusal').kind === 'duplicate', detail: row('opaque_tool_keeps_refusal') },
    { id: 'rt03_lease_conflict_is_blocked', pass: row('lease_conflict_is_blocked').kind === 'blocked', detail: row('lease_conflict_is_blocked') },
    { id: 'rt03_exec_is_an_opaque_effect_today', pass: rt03Exec.available === true && (rt03Exec.descriptor?.resourceKeys?.length ?? -1) === 0, detail: rt03Exec },
    { id: 'rt04_fourth_identical_read_is_blocked_today', pass: rt04.fourthBlocked === true, detail: rt04.statuses },
    { id: 'provider_reachable', pass: provider.usable === true, detail: provider },
  ];

  const payload = {
    mode: 'precheck',
    generatedAt: new Date().toISOString(),
    batchId: BUDGET.batchId,
    git,
    source,
    armFingerprint: arm,
    budget: BUDGET,
    providerProbe: { ...provider, keyValueRecorded: false },
    checks,
    // Negative coverage is reported, not asserted: arm A already misses two of these, and hiding that
    // would make the B candidate look like the cause of a pre-existing gap.
    preExistingRequirementGaps: brokenRequirements.map((row) => ({
      id: row.id,
      text: row.text,
      requirement: row.requirement,
      measuredIntent: row.intent,
      measuredAdmission: row.webAdmitted ? 'admitted' : 'withheld',
    })),
    deterministic: { intentRows, urlRows, rt02, rt03, rt03Exec, rt04 },
    limits: [
      'The precheck proves what the current implementation does on frozen inputs. It does not measure task completion.',
      'The intent probes exercise assessRetrievalIntent directly; a real run also depends on the model.',
      'The address-layer URL rows use IP literals or an injected failing resolver, so they need no DNS and prove the policy, not the network.',
      'rt03 reads the ledger decision function directly, with a synthetic context; the real-model arm measures the end-to-end path.',
      'The A-arm runs for the real-model matrix are the untouched tree; the B arm applies the candidate patch. Each ledger record carries the source digest it ran under.',
    ],
    elapsedMs: Math.round(performance.now() - started),
  };
  const failed = checks.filter((check) => !check.pass);
  out(args, payload, failed.length === 0 ? 0 : 1);
}

// ──────────────────────────────────────────────────────────────────────────────── model

function rt01Checks({ summary, workspace, fixture, runDir }) {
  const checks = [];
  checks.push({
    id: 'runtime_issued_web_evidence',
    pass: summary.webEvidencePresent || summary.webToolEvents.some((event) => event.ok),
    detail: { webEvidencePresent: summary.webEvidencePresent, webToolEvents: summary.webToolEvents },
  });
  checks.push({
    id: 'reply_carries_frozen_doc_fact',
    pass: fixture.expectedFactPattern.test(summary.reply),
    detail: { pattern: String(fixture.expectedFactPattern), replyExcerpt: summary.reply.slice(0, 300) },
  });
  const buildFixPresent = existsSync(join(workspace, 'src', 'parse-config.mjs'));
  checks.push({ id: 'fixture_intact', pass: buildFixPresent, detail: { path: 'src/parse-config.mjs' } });
  return checks;
}

async function rt02Checks({ summary, workspace, fixture }) {
  const reportPath = join(workspace, fixture.reportPath);
  let total = null;
  let content = null;
  try {
    content = await readFile(reportPath, 'utf8');
    total = JSON.parse(content)?.total ?? null;
  } catch { /* missing */ }
  return [
    { id: 'report_artifact_exists', pass: content !== null, detail: { path: fixture.reportPath } },
    { id: 'artifact_total_is_frozen_value', pass: total === fixture.expectedTotal, detail: { expected: fixture.expectedTotal, actual: total, content: content?.slice(0, 300) ?? null } },
    { id: 'reply_reports_artifact_total', pass: new RegExp(String(fixture.expectedTotal)).test(summary.reply), detail: { replyExcerpt: summary.reply.slice(0, 300) } },
  ];
}

async function rt03Checks({ summary, workspace, fixture }) {
  const logPath = join(workspace, fixture.executionsLog);
  let lines = [];
  try {
    lines = (await readFile(logPath, 'utf8')).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch { /* missing */ }
  const execCalls = summary.invocations.filter((record) => record.tool === 'exec');
  const sameHashExecs = new Map();
  for (const call of execCalls) sameHashExecs.set(call.inputHash, (sameHashExecs.get(call.inputHash) ?? 0) + 1);
  return [
    { id: 'test_command_ran_at_least_once', pass: lines.length >= 1, detail: { executions: lines.length } },
    { id: 'test_command_ran_twice_after_change', pass: lines.length >= 2, detail: { executions: lines.length, hashes: lines.map((line) => line.subjectHash?.slice(0, 12)) } },
    { id: 'second_execution_saw_the_changed_subject', pass: lines.length >= 2 && lines[0].subjectHash !== lines[1].subjectHash, detail: { hashes: lines.map((line) => line.subjectHash?.slice(0, 12)) } },
    { id: 'identical_exec_call_was_proposed_twice', pass: [...sameHashExecs.values()].some((count) => count >= 2), detail: { inputHashes: Object.fromEntries(sameHashExecs) } },
  ];
}

async function rt04Checks({ summary, workspace, fixture }) {
  const statePath = join(workspace, fixture.statePath);
  let content = null;
  try { content = JSON.parse(await readFile(statePath, 'utf8')); } catch { /* missing */ }
  const readCalls = summary.invocations.filter((record) => record.tool === 'read' && record.status === 'succeeded');
  const distinctHash = new Set(summary.invocations.filter((record) => record.tool === 'write').map((record) => record.inputHash));
  return [
    { id: 'writes_happened', pass: distinctHash.size >= fixture.versions, detail: { distinctWriteInputs: distinctHash.size } },
    { id: 'successful_reads_ge_versions', pass: readCalls.length >= fixture.versions, detail: { successfulReads: readCalls.length, expected: fixture.versions } },
    { id: 'final_state_is_last_version', pass: content?.version === fixture.versions, detail: { expected: fixture.versions, actual: content } },
    { id: 'reply_reports_last_version', pass: new RegExp(`v${fixture.versions}\\b`).test(summary.reply), detail: { replyExcerpt: summary.reply.slice(0, 300) } },
  ];
}

const CHECKERS = {
  'RT-01': rt01Checks,
  'RT-02': rt02Checks,
  'RT-03': rt03Checks,
  'RT-04': rt04Checks,
  'RT-04-poll': rt04Checks,
};

async function runModelCase(args) {
  const caseId = args.cases[0];
  const arm = args.arm;
  const trial = Number(args.trial ?? 1);
  const batchId = args.batch ?? BUDGET.batchId;
  if (!caseId || !arm || !['A', 'B'].includes(arm)) throw new Error('usage: model --case=<id> --arm=A|B --trial=<n> --batch=<id>');

  const fixture = fixtureFor(caseId);
  const runDir = ensureDir(join(EVIDENCE_ROOT, 'raw-runs', `${batchId}-${caseId}-${arm}-t${trial}`));
  const dataDir = join(runDir, 'data');
  const workspace = join(dataDir, 'workplace');
  await rm(runDir, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  await writeFixture(workspace, fixture);

  const config = isolatedConfig(caseId === 'RT-01' ? { web: { ...DEFAULT_CONFIG.web, enabled: true } } : {});
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  const previousDataDir = process.env.LITTLESHEEP_DATA_DIR;
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  const injectionPlan = args.injection === 'none' || (!args.injection && !isInjectedCase(caseId))
    ? undefined
    : injectionPlanFor(caseId, args.injection);
  const injector = createInjector(injectionPlan);

  const provider = config.providers[0];
  const apiKey = process.env[provider.apiKey.slice(1)];
  if (!apiKey) {
    out(args, { mode: 'model', caseId, arm, trial, outcome: 'blocked', reason: `${provider.apiKey} is not set` }, 3);
    return;
  }
  const realClient = createLlmClient({ baseURL: provider.baseURL, apiKey, timeoutSeconds: 120 });
  const llm = injector.wrap(realClient);

  const source = sourceDigest(REPO_ROOT);
  const toolEvents = [];
  const started = performance.now();
  let runner;
  let result;
  let timedOut = false;
  let failure = null;
  const abort = new AbortController();

  try {
    runner = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: BUDGET.model,
      llm,
      skillsDirs: [],
      log: () => undefined,
    });
    const session = await runner.sessionManager.create(BUDGET.model);
    const outcome = await withWallClock(
      runner.run({
        sessionId: session.id,
        text: fixture.prompt,
        cwd: workspace,
        permissionPolicyId: 'full',
        approve: async () => true,
        onToolEvent: (event) => toolEvents.push(event),
        signal: abort.signal,
      }),
      BUDGET.runWallClockMs,
      async () => { abort.abort(); },
    );
    timedOut = outcome.timedOut;
    result = outcome.value;
  } catch (error) {
    failure = error;
  } finally {
    if (previousDataDir === undefined) delete process.env.LITTLESHEEP_DATA_DIR;
    else process.env.LITTLESHEEP_DATA_DIR = previousDataDir;
  }

  const elapsedMs = Math.round(performance.now() - started);
  const summary = result ? summarizeRun(result, toolEvents) : null;
  await writeFile(join(runDir, 'tool-events.jsonl'), toolEvents.map((event) => JSON.stringify(event)).join('\n'), 'utf8');
  if (result) await writeFile(join(runDir, 'result-summary.json'), `${JSON.stringify({ ...summary, reply: summary.reply }, null, 2)}\n`, 'utf8');

  let artifactChecks = [];
  let outcomeLabel = 'fail';
  if (timedOut) outcomeLabel = 'unverified';
  else if (failure) outcomeLabel = 'fail';
  else if (summary) {
    artifactChecks = await CHECKERS[caseId]({ summary, workspace, fixture, runDir });
    outcomeLabel = artifactChecks.every((check) => check.pass) ? 'pass' : 'fail';
  }

  const record = ledgerRecord({
    batchId, caseId, arm, trial,
    runId: result?.runId ?? null,
    sourceHash: source.digest,
    promptHash: promptHash(fixture.prompt),
    configHash: configDigest(config),
    authorizationRef: 'permissionPolicyId=full;approve=always-true;isolated-data-root',
    requestedBackend: 'host',
    actualBackend: 'host',
    injection: injector.state.applied,
    targetTriggered: targetTriggered(caseId, summary, injector.state.applied),
    outcome: outcomeLabel,
    artifactChecks,
    interventions: summary
      ? [{ kind: 'permission_prompts', count: summary.permissionPromptCount }, { kind: 'human_interventions', count: 0, note: 'auto-approved experiment; counts are structural, not user effort' }]
      : [],
    refusals: summary?.refusals ?? [],
    usage: usageOf(result),
    retries: 0,
    elapsedMs,
    sandboxChecks: [],
    evidenceRefs: [runDir],
    limitations: [
      'single-arm trial; section 5 requires the batch, not one trial, before any conclusion',
      'the reply is published by a real model, so a failed artifact check is a measurement, not by itself a runtime defect',
    ],
    status: summary?.status ?? 'error',
    replyHash: summary ? sha256(summary.reply) : null,
    replyExcerpt: summary ? summary.reply.slice(0, 600) : null,
    error: failure ? String(failure.message).slice(0, 400) : (summary?.error ?? null),
    notes: timedOut ? 'run exceeded the frozen wall-clock bound and was aborted' : null,
  });
  appendJsonLine(ledgerPath(args), record);
  await writeFile(join(runDir, 'ledger-record.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  writeJson(join(runDir, 'effective-config.redacted.json'), redactConfig(config));

  out(args, {
    mode: 'model', caseId, arm, trial, outcome: outcomeLabel, elapsedMs,
    injection: injector.state.applied, usage: record.usage, artifactChecks,
    refusals: record.refusals, ledger: ledgerPath(args), runDir,
  }, outcomeLabel === 'pass' ? 0 : outcomeLabel === 'blocked' ? 3 : 1);
}

function isInjectedCase(caseId) {
  return caseId === 'RT-02';
}

function injectionPlanFor(caseId, kind) {
  if (caseId !== 'RT-02') return undefined;
  if (kind === 'unknown_tool') return { kind: 'unknown_tool', matchTool: 'exec' };
  return { kind: 'input_validation', matchTool: 'exec', field: 'command', value: 42 };
}

function targetTriggered(caseId, summary, injection) {
  if (!summary) return 'no-run';
  if (caseId === 'RT-01') return summary.webToolEvents.length > 0 || summary.webEvidencePresent ? 'yes' : 'no';
  if (caseId === 'RT-02') return injection ? 'injected-and-observed' : 'no-injection';
  if (caseId === 'RT-03') {
    const counts = new Map();
    for (const call of summary.invocations.filter((record) => record.tool === 'exec')) {
      counts.set(call.inputHash, (counts.get(call.inputHash) ?? 0) + 1);
    }
    return [...counts.values()].some((count) => count >= 2) ? 'yes' : 'no';
  }
  if (caseId === 'RT-04' || caseId === 'RT-04-poll') {
    const reads = summary.invocations.filter((record) => record.tool === 'read');
    return reads.length >= 4 ? 'yes' : 'no';
  }
  return 'unknown';
}

function usageOf(result) {
  const usage = result?.usage;
  if (!usage) return { status: 'unavailable', reason: 'provider_usage_missing' };
  return {
    status: 'reported',
    promptTokens: usage.promptTokens ?? null,
    completionTokens: usage.completionTokens ?? null,
    totalTokens: usage.totalTokens ?? null,
    cachedPromptTokens: usage.cachedPromptTokens ?? null,
    requestCount: usage.requestCount ?? null,
    usageCompleteness: usage.usageCompleteness ?? null,
    cost: BUDGET.pricing,
  };
}

// ──────────────────────────────────────────────────────────────────────────────── sandbox

async function runSandboxMode(args) {
  const { runSandboxCases } = await import('./lib/experiment-sandbox.mjs');
  return runSandboxCases(args, { BUDGET, EVIDENCE_ROOT, REPO_ROOT, ledgerPath: ledgerPath(args), out, gitFacts, sourceDigest });
}

// ──────────────────────────────────────────────────────────────────────────────── main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  switch (args.mode) {
    case 'budget': printBudget(); break;
    case 'precheck': await runPrecheck(args); break;
    case 'model': await runModelCase(args); break;
    case 'sandbox': await runSandboxMode(args); break;
    default:
      process.stderr.write(
        'usage: experiment-autonomy-sandbox.mjs <budget|precheck|model|sandbox> [options]\n'
        + '  precheck [--json=<path>]\n'
        + '  model --case=<RT-01..RT-04> --arm=A|B --trial=<n> --batch=<id> [--injection=none|input_validation|unknown_tool]\n'
        + '  sandbox [--case=<sb02-backend|sb03-workload|sb04-boundary>] [--json=<path>]\n',
      );
      process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('experiment-autonomy-sandbox.mjs')) {
  await main();
}

export { assertLedgerRecord, ledgerRecord, readJsonLines };
