import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'vitest';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { createRunner, type AgentRunner, type RunnerResult } from '@littlesheep/runner';
import type { AgentTool } from '@littlesheep/types';
import { createS3bMeasuredProvider } from './s3b-provider-metering.js';
import { resolveS3bProviderProfile } from '../scripts/lib/s3b-provider-config.mjs';
import { z } from 'zod';

const realTaskIds = ['CODE-01', 'FILE-02', 'DELIV-01', 'MULTI-01'] as const;
const activeRunners: AgentRunner[] = [];
let transientRoot = '';

afterEach(async () => {
  const failures: string[] = [];
  for (const runner of activeRunners.splice(0)) {
    try { await runner.shutdown(); } catch (error) { failures.push(`runner shutdown: ${String(error)}`); }
  }
  if (transientRoot) {
    try { await rm(transientRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch (error) { failures.push(`temporary root cleanup: ${String(error)}`); }
    transientRoot = '';
  }
  delete process.env.LITTLESHEEP_DATA_DIR;
  if (failures.length) throw new Error(`S3B live-task teardown failed: ${failures.join('; ')}`);
});

function sha256(input: string | Buffer) {
  return createHash('sha256').update(input).digest('hex');
}

async function setup(id: string) {
  transientRoot = process.env.S3B_TASK_ROOT || await mkdtemp(join(tmpdir(), `ls-s3b-real-${id.toLowerCase()}-`));
  const workspace = join(transientRoot, 'workspace');
  const dataDir = join(transientRoot, 'runtime-data');
  await mkdir(workspace, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  return { root: transientRoot, workspace, dataDir, startedAt: new Date().toISOString(), started: performance.now() };
}

function runPermission(workspace: string) {
  return {
    version: 2 as const,
    preset: 'workspace-write' as const,
    approvalPolicy: 'prompt' as const,
    workspaceRoot: workspace,
    protectedRoots: [] as string[],
    constraints: { workspaceFileWrites: 'available' as const, shellIsolation: 'unavailable' as const },
    fullAccessConfirmed: false,
  };
}

async function readTaskSuite() {
  return JSON.parse(await readFile(resolve('docs/reference/rcd-s3a-task-suite-2026-10-17.json'), 'utf8')) as {
    tasks: Array<{ id: string; userInput: string; seed: Record<string, string>; allowedTools: string[] }>;
  };
}

async function saveObservation(taskId: string, observation: Record<string, unknown>) {
  const path = process.env.S3B_OBSERVATION_PATH;
  if (!path) throw new Error('S3B_OBSERVATION_PATH is required by the evaluation runner.');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, taskId, observation }, null, 2)}\n`, 'utf8');
}

async function seedTask(workspace: string, seed: Record<string, string>) {
  for (const [relativePath, content] of Object.entries(seed)) {
    const target = resolve(workspace, relativePath);
    const local = relative(resolve(workspace), target);
    if (!local || local.startsWith('..') || isAbsolute(local)) throw new Error('task fixture seed escaped the isolated workspace');
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

async function reportMetrics(input: {
  taskId: string;
  task: { allowedTools: string[] };
  env: Awaited<ReturnType<typeof setup>>;
  provider: ReturnType<typeof createS3bMeasuredProvider>;
  run: RunnerResult | null;
  runtimeException?: unknown;
  runStarted: boolean;
  oracle: Record<string, unknown>;
  runtimeStatus?: string | null;
  approvals: number;
}) {
  const meter = input.provider.snapshot();
  const calls = input.run?.toolInvocations ?? [];
  const effects = input.run?.sideEffects ?? [];
  const advertisedToolNames = [...new Set((input.run?.modelRequests ?? []).flatMap(request => request.toolNames))].sort();
  const taskResult = String(input.oracle.taskResult ?? input.oracle.result ?? 'unverified');
  const falseCompletionClaim = input.run?.reply
    ? taskResult !== 'passed' && /complete|completed|done|success|created|updated/iu.test(input.run.reply)
    : null;
  const providerHttpFailures = meter.physicalResponses.filter(response => response.status === null || response.status >= 400).length;
  const observation = {
    executionLayer: 'Runner/Harness/Tools with the existing LlmClient wire adapter and real Provider; no scripted model tool sequence',
    infrastructureStatus: input.runtimeException && !input.runStarted && meter.physicalProviderRequests === 0 ? 'harness_error' : 'executed',
    runtimeStatus: input.run?.status ?? input.runtimeStatus ?? null,
    runtimeFinalStatus: input.run?.runtimeStatus ?? null,
    runId: input.run?.runId ?? null,
    taskOutcome: {
      status: input.run?.taskOutcome?.status ?? 'unknown',
      requirementInventory: input.run?.taskOutcome?.requirementInventory ?? 'unknown',
      requirementStatuses: input.run?.taskOutcome?.requirements?.map(requirement => requirement.status) ?? [],
    },
    toolScope: {
      declaredAllowedTools: input.task.allowedTools,
      advertisedToolNames,
      commandScopedShellNotOffered: input.task.allowedTools.filter(name => name.startsWith('exec:')),
    },
    falseCompletionClaim,
    provider: {
      type: 'real', simulated: false, id: process.env.S3B_PROVIDER_ID ?? null,
      model: process.env.S3B_MODEL ?? null, apiProtocol: process.env.S3B_API_PROTOCOL ?? null,
      endpointOrigin: (() => { try { return new URL(process.env.S3B_BASE_URL ?? '').origin; } catch { return null; } })(),
      modelVersion: meter.responseModelIds.length > 0 ? [...new Set(meter.responseModelIds)] : null,
      parameters: {
        observed: meter.observedParameters,
        topP: null, seed: null,
        unsupported: ['top_p', 'seed'],
      },
      limits: {
        physicalRequestBudget: Number(process.env.S3B_MAX_PHYSICAL_REQUESTS),
        outputTokenLimit: Number(process.env.S3B_MAX_OUTPUT_TOKENS),
        userApprovedMaxCostUsd: Number(process.env.S3B_MAX_COST_USD),
        providerBillingCapConfirmed: process.env.S3B_PROVIDER_BILLING_CAP_CONFIRMED === 'true',
        timeoutSeconds: Number(process.env.S3B_TIMEOUT_SECONDS ?? '120'),
        maxAttempts: Number(process.env.S3B_MAX_ATTEMPTS ?? '1'),
      },
    },
    logicalModelRequests: meter.logicalModelRequests,
    logicalEmbeddingRequests: meter.logicalEmbeddingRequests,
    physicalProviderRequests: meter.physicalProviderRequests,
    blockedPhysicalRequests: meter.blockedPhysicalRequests,
    toolCallProposals: meter.toolCallProposals,
    toolExecutions: calls.filter(call => call.status === 'succeeded').length,
    deniedToolCalls: calls.filter(call => call.status === 'denied' || call.status === 'blocked').length,
    failedToolCalls: calls.filter(call => call.status === 'failed' || call.status === 'validation_failed').length,
    settledEffects: effects.filter(effect => effect.status === 'succeeded').length,
    unknownEffects: effects.filter(effect => effect.status === 'unknown').length,
    invocationEvidence: calls.map(call => ({ toolName: call.toolName, status: call.status, errorKind: call.errorKind })),
    effectEvidence: effects.map(effect => ({ toolName: effect.toolName, status: effect.status, idempotencyKey: effect.idempotencyKey })),
    usage: meter.usage,
    cost: { status: 'unavailable', value: null, source: null, reason: 'Provider returned no authoritative billing receipt; no cost was inferred from tokens' },
    network: {
      providerHttpRequests: meter.physicalProviderRequests,
      agentWebRequests: calls.filter(call => (call.toolName === 'web_search' || call.toolName === 'web_fetch') && call.status === 'succeeded').length,
      forbiddenRequests: 0,
      providerHttpFailures,
      agentPolicy: 'Web tools disabled; task network rules apply to Agent tools. The separately authorized Provider API transport is measured as evaluation infrastructure traffic.',
    },
    approvals: { count: input.approvals, source: 'trusted Runner approve callback invocation count' },
    oracle: input.oracle,
    runtimeException: input.runtimeException ? {
      name: input.runtimeException instanceof Error ? input.runtimeException.name : 'unknown',
      providerStatus: typeof input.runtimeException === 'object' && input.runtimeException && 'status' in input.runtimeException && typeof input.runtimeException.status === 'number'
        ? input.runtimeException.status : null,
    } : null,
    startedAt: input.env.startedAt,
    endedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - input.env.started),
  };
  await saveObservation(input.taskId, observation);
}

describe('S3B live Provider task trials', () => {
  it.each(realTaskIds)('S3B real %s lets the Provider choose actions and checks the fixed external Oracle', async taskId => {
    if (process.env.S3B_PROVIDER_MODE !== 'real' || process.env.S3B_TASK_ID !== taskId) return;
    const profile = resolveS3bProviderProfile(process.env);
    if (!profile.ready || !profile.credentials) throw new Error('real Provider preflight was not satisfied');

    const task = (await readTaskSuite()).tasks.find(item => item.id === taskId);
    if (!task) throw new Error(`missing frozen task ${taskId}`);
    const env = await setup(taskId);
    await seedTask(env.workspace, task.seed);
    const provider = createS3bMeasuredProvider({ profile });
    const modelRef = `${profile.credentials.providerId}/${profile.credentials.model}`;
    const config = structuredClone(DEFAULT_CONFIG);
    config.agents.defaults.model = modelRef;
    config.web.enabled = false;
    let approvals = 0;
    let runner: AgentRunner | undefined;
    let run: RunnerResult | null = null;
    let runtimeException: unknown;
    let runStarted = false;
    let oracle: Record<string, unknown> = { status: 'failed', taskResult: 'failed', evaluationCheck: 'unverified', method: 'Run did not produce a complete external Oracle observation', evidence: [] };

    try {
      runner = await createRunner({ config, branding: DEFAULT_BRANDING, model: modelRef, llm: provider.client, skillsDirs: [] });
      activeRunners.push(runner);
      const additionalTools: AgentTool[] = [];
      let fixtureExecutions = 0;
      const fixtureBytes = Buffer.from('verified-output', 'utf8');
      if (taskId === 'DELIV-01') {
        additionalTools.push({
          name: 'fixture_write_exact',
          description: 'Write one text file inside the isolated evaluation workspace.',
          inputSchema: z.object({ path: z.string(), content: z.string() }).strict(),
          execution: { concurrency: 'exclusive', resources: () => [{ key: 'workspace:result.txt', mode: 'write' }] },
          async execute(input) {
            const args = input as { path: string; content: string };
            if (args.path !== 'result.txt') return { callId: '', ok: false, error: 'fixture path is outside task contract' };
            fixtureExecutions += 1;
            await writeFile(join(env.workspace, 'result.txt'), args.content, 'utf8');
            return { callId: '', ok: true, output: 'fixture file written' };
          },
        });
      }

      runStarted = true;
      run = await runner.run({
        text: task.userInput,
        cwd: env.workspace,
        origin: 'test',
        permissionPreset: 'workspace-write',
        permissionPolicyV2: runPermission(env.workspace),
        toolFilter: tool => task.allowedTools.some(name => tool.name === name),
        ...(additionalTools.length ? { additionalTools } : {}),
        approve: async () => { approvals += 1; return true; },
      });

      if (taskId === 'CODE-01') {
        const file = join(env.workspace, 'src', 'label.mjs');
        const bytes = await readFile(file).catch(() => Buffer.alloc(0));
        const value = bytes.byteLength > 0
          ? execFileSync(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(pathToFileURL(file).href)}); process.stdout.write(m.taskLabel());`], { cwd: env.workspace, encoding: 'utf8' })
          : '';
        const passed = value === 'ready' && bytes.toString('utf8').includes('return "ready"');
        oracle = { status: passed ? 'passed' : 'failed', taskResult: passed ? 'passed' : 'failed', evaluationCheck: passed ? 'passed' : 'failed', method: 'Independent Node process imports the resulting synthetic module and checks taskLabel() plus file bytes', expected: 'ready', actual: value, evidence: [{ path: 'src/label.mjs', sha256: sha256(bytes), bytes: bytes.byteLength }] };
      } else if (taskId === 'FILE-02') {
        const file = join(env.workspace, 'inventory-summary.json');
        const bytes = await readFile(file).catch(() => Buffer.alloc(0));
        const entries = (await readdir(env.workspace)).sort();
        let actual: unknown = null;
        try { actual = JSON.parse(bytes.toString('utf8')); } catch { /* Oracle retains invalid JSON as a failure. */ }
        const expected = { total: 5, items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 3 }] };
        const passed = JSON.stringify(actual) === JSON.stringify(expected) && JSON.stringify(entries) === JSON.stringify(['inventory-summary.json', 'inventory.csv']);
        oracle = { status: passed ? 'passed' : 'failed', taskResult: passed ? 'passed' : 'failed', evaluationCheck: passed ? 'passed' : 'failed', method: 'Independent disk read, JSON parse, exact value and file-set check', expected, actual, files: entries, evidence: [{ path: 'inventory-summary.json', sha256: sha256(bytes), bytes: bytes.byteLength }] };
      } else if (taskId === 'DELIV-01') {
        const file = join(env.workspace, 'result.txt');
        const bytes = await readFile(file).catch(() => Buffer.alloc(0));
        const calls = run.toolInvocations ?? [];
        const validationFailure = calls.some(call => call.status === 'validation_failed' && call.errorKind === 'input_validation');
        const passed = validationFailure && fixtureExecutions === 1 && bytes.toString('utf8') === 'verified-output';
        oracle = { status: passed ? 'passed' : 'failed', taskResult: passed ? 'passed' : 'failed', evaluationCheck: passed ? 'passed' : 'failed', method: 'Independent file read plus ToolInvocationRecord confirms schema feedback before one successful fixture write', validationFailure, fixtureExecutions, contentMatches: bytes.equals(fixtureBytes), evidence: [{ path: 'result.txt', sha256: sha256(bytes), bytes: bytes.byteLength }] };
      } else {
        const a = await readFile(join(env.workspace, 'a.txt')).catch(() => Buffer.alloc(0));
        const b = await readFile(join(env.workspace, 'b.txt')).catch(() => Buffer.alloc(0));
        const outcome = run.taskOutcome;
        const passed = a.toString('utf8') === 'hello' && b.toString('utf8') === 'world'
          && outcome?.requirements?.length === 2
          && outcome.requirements.every(requirement => requirement.status === 'passed')
          && outcome.status === 'completed'
          && outcome.requirementInventory === 'complete';
        oracle = { status: passed ? 'passed' : 'failed', taskResult: passed ? 'passed' : 'failed', evaluationCheck: passed ? 'passed' : 'failed', method: 'Independent disk reads plus persisted Task Outcome requirement checks; model summary is ignored', taskOutcomeStatus: outcome?.status ?? 'unknown', requirementInventory: outcome?.requirementInventory ?? 'unknown', requirementStatuses: outcome?.requirements?.map(requirement => requirement.status) ?? [], evidence: [{ path: 'a.txt', sha256: sha256(a), bytes: a.byteLength }, { path: 'b.txt', sha256: sha256(b), bytes: b.byteLength }] };
      }
      if (taskId === 'DELIV-01') {
        (oracle as Record<string, unknown>).fixtureExecutions = fixtureExecutions;
      }
    } catch (error) {
      runtimeException = error;
    }

    await reportMetrics({ taskId, task, env, provider, run, runtimeException, runStarted, oracle, approvals, runtimeStatus: runtimeException ? 'error' : null });
  }, 300_000);
});
