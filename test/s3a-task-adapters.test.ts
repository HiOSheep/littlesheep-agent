import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm';
import { createRunner } from '@littlesheep/runner';
import type { AgentTool } from '@littlesheep/types';

const adapterIds = ['CODE-01', 'FILE-02', 'DELIV-01', 'MULTI-01'] as const;
const activeRunners: Array<{ shutdown(): Promise<void> }> = [];
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
  if (failures.length) throw new Error(`S3A teardown failed: ${failures.join('; ')}`);
});

function responseForTool(id: string, name: string, args: unknown): ChatResponse {
  return {
    content: '', finishReason: 'tool_calls',
    toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

function text(content = 'The requested fixture task has ended.'): ChatResponse {
  return { content, toolCalls: [], finishReason: 'stop' };
}

function scriptedLlm(next: (request: ChatRequest, call: number) => ChatResponse) {
  let calls = 0;
  const chat = async (request: ChatRequest) => next(request, ++calls);
  const llm: LlmClient = {
    chat,
    chatStream: async (request: ChatRequest, onDelta: (chunk: StreamChunk) => void) => {
      const result = await chat(request);
      if (result.content) onDelta({ type: 'delta', delta: result.content });
      onDelta({ type: 'done', finishReason: result.finishReason });
      return result;
    },
    embed: async () => ({ embeddings: [], model: 'scripted-unavailable', usage: { promptTokens: 0 } }),
  };
  return { llm, requestCount: () => calls };
}

function queuedLlm(responses: ChatResponse[]) {
  return scriptedLlm(() => responses.shift() ?? text('The controlled response sequence is exhausted.'));
}

function toolMessageContains(request: ChatRequest, term: string): boolean {
  return request.messages.some((message) => message.role === 'tool' && String(message.content).toLowerCase().includes(term.toLowerCase()));
}

async function setup(id: string) {
  const requestedRoot = process.env.S3A_TASK_ROOT;
  transientRoot = requestedRoot || await mkdtemp(join(tmpdir(), `ls-s3a-${id.toLowerCase()}-`));
  const workspace = join(transientRoot, 'workspace');
  const dataDir = join(transientRoot, 'runtime-data');
  await mkdir(workspace, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  return { workspace, dataDir, startedAt, started };
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

async function startRunner(model: string, llm: LlmClient) {
  const runner = await createRunner({ config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING, model, llm, skillsDirs: [] });
  activeRunners.push(runner);
  return runner;
}

function sha256(input: string | Buffer) {
  return createHash('sha256').update(input).digest('hex');
}

async function report(id: string, observation: Record<string, unknown>) {
  const path = process.env.S3A_OBSERVATION_PATH;
  if (!path) throw new Error('S3A_OBSERVATION_PATH is required by the evaluation runner.');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, taskId: id, observation }, null, 2)}\n`, 'utf8');
}

describe('S3A controlled Runner/Harness task adapters', () => {
  it.each(adapterIds)('S3A %s uses a controlled Provider and an external fixture Oracle', async (id) => {
    if (process.env.S3A_TASK_ID !== id) return;

    if (id === 'CODE-01') {
      const env = await setup(id);
      const sourcePath = join(env.workspace, 'src', 'label.mjs');
      await mkdir(join(env.workspace, 'src'), { recursive: true });
      await writeFile(sourcePath, 'export function taskLabel(){ return "old"; }\n', 'utf8');
      const model = queuedLlm([
        responseForTool('code-read', 'read', { file_path: sourcePath }),
        responseForTool('code-write', 'write', { file_path: 'src/label.mjs', content: 'export function taskLabel(){ return "ready"; }\n' }),
        text('Updated the helper.'),
      ]);
      const runner = await startRunner(`s3a/${id}`, model.llm);
      const run = await runner.run({ text: 'In src/label.mjs, change taskLabel() so it returns the exact string "ready".', cwd: env.workspace, origin: 'test', approve: async () => true, permissionPreset: 'workspace-write', permissionPolicyV2: runPermission(env.workspace) });
      const actualBytes = await readFile(sourcePath);
      const oracleValue = execFileSync(process.execPath, ['--input-type=module', '-e', `const mod = await import(${JSON.stringify(pathToFileURL(sourcePath).href)}); process.stdout.write(mod.taskLabel());`], { cwd: env.workspace, encoding: 'utf8' });
      const oraclePassed = oracleValue === 'ready' && actualBytes.toString('utf8').includes('return "ready"');
      await report(id, {
        executionLayer: 'Runner/Harness/Tools with scripted Provider; no production source changes', provider: { type: 'scripted', simulated: true, physicalUsage: 'unavailable' },
        runId: run.runId, runtimeStatus: run.status, runtimeFinalStatus: run.runtimeStatus ?? null, modelRequests: model.requestCount(),
        toolCalls: run.toolInvocations?.length ?? null, toolExecutions: run.toolInvocations?.filter((call) => call.status === 'succeeded').length ?? null,
        oracle: { status: oraclePassed ? 'passed' : 'failed', taskResult: oraclePassed ? 'passed' : 'failed', method: 'Separate Node process imports the resulting fixture module and checks its return value; adapter also checks exact bytes', result: oracleValue, evidence: [{ path: 'src/label.mjs', sha256: sha256(actualBytes), bytes: actualBytes.byteLength }] },
        userInterventions: { approvals: 0, continuePrompts: 0 }, usage: { status: 'unavailable', inputTokens: null, outputTokens: null, cost: null },
        elapsedMs: Math.round(performance.now() - env.started), startedAt: env.startedAt, endedAt: new Date().toISOString(), infrastructureStatus: 'executed',
      });
      return;
    }

    if (id === 'FILE-02') {
      const env = await setup(id);
      await writeFile(join(env.workspace, 'inventory.csv'), 'sku,qty\nB,3\nA,2\n', 'utf8');
      const model = queuedLlm([
        responseForTool('batch-read', 'read', { file_path: 'inventory.csv' }),
        responseForTool('batch-write', 'write', { file_path: 'inventory-summary.json', content: '{"total":5,"items":[{"sku":"A","qty":2},{"sku":"B","qty":3}]}\n' }),
        text('The inventory summary was written.'),
      ]);
      const runner = await startRunner(`s3a/${id}`, model.llm);
      const run = await runner.run({ text: 'Read inventory.csv and create inventory-summary.json with total quantity 5 and items sorted by sku, preserving each quantity.', cwd: env.workspace, origin: 'test', approve: async () => true, permissionPreset: 'workspace-write', permissionPolicyV2: runPermission(env.workspace) });
      const bytes = await readFile(join(env.workspace, 'inventory-summary.json')).catch(() => Buffer.alloc(0));
      const files = (await readdir(env.workspace)).sort();
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch { parsed = null; }
      const expected = { total: 5, items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 3 }] };
      const oraclePassed = JSON.stringify(parsed) === JSON.stringify(expected) && JSON.stringify(files) === JSON.stringify(['inventory-summary.json', 'inventory.csv']);
      await report(id, {
        executionLayer: 'Runner/Harness/Tools with scripted Provider; real isolated file read/write', provider: { type: 'scripted', simulated: true, physicalUsage: 'unavailable' },
        runId: run.runId, runtimeStatus: run.status, runtimeFinalStatus: run.runtimeStatus ?? null, modelRequests: model.requestCount(), toolCalls: run.toolInvocations?.length ?? null,
        oracle: { status: oraclePassed ? 'passed' : 'failed', taskResult: oraclePassed ? 'passed' : 'failed', method: 'Independent JSON parse, exact normalized value and workspace file-set comparison', expected, actual: parsed, files, evidence: [{ path: 'inventory-summary.json', sha256: sha256(bytes), bytes: bytes.byteLength }] },
        userInterventions: { approvals: 0, continuePrompts: 0 }, usage: { status: 'unavailable', inputTokens: null, outputTokens: null, cost: null },
        elapsedMs: Math.round(performance.now() - env.started), startedAt: env.startedAt, endedAt: new Date().toISOString(), infrastructureStatus: 'executed',
      });
      return;
    }

    if (id === 'DELIV-01') {
      const env = await setup(id);
      let actualExecutions = 0;
      const target = join(env.workspace, 'result.txt');
      const fixtureTool: AgentTool = {
        name: 'fixture_write_exact',
        description: 'Write one text file inside the isolated evaluation workspace.',
        inputSchema: z.object({ path: z.string(), content: z.string() }).strict(),
        execution: { concurrency: 'exclusive', resources: () => [{ key: 'workspace:result.txt', mode: 'write' }] },
        async execute(input) {
          const args = input as { path: string; content: string };
          if (args.path !== 'result.txt') return { callId: '', ok: false, error: 'fixture path is outside task contract' };
          actualExecutions += 1;
          await writeFile(target, args.content, 'utf8');
          return { callId: '', ok: true, output: 'fixture file written' };
        },
      };
      const model = scriptedLlm((request) => {
        const feedbackWasReturned = toolMessageContains(request, 'runtime_schema');
        if (!feedbackWasReturned) return responseForTool('invalid-proposal', 'fixture_write_exact', { filepath: 'result.txt', content: 'verified-output' });
        if (toolMessageContains(request, 'fixture file written')) return text('Corrected the tool input and wrote the requested file.');
        return responseForTool('corrected-proposal', 'fixture_write_exact', { path: 'result.txt', content: 'verified-output' });
      });
      const runner = await createRunner({ config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING, model: `s3a/${id}`, llm: model.llm, skillsDirs: [] });
      activeRunners.push(runner);
      const run = await runner.run({ text: 'Use the fixture writer to create result.txt containing exactly verified-output. Correct any parameter validation error before stopping.', cwd: env.workspace, origin: 'test', approve: async () => true, permissionPreset: 'workspace-write', permissionPolicyV2: runPermission(env.workspace), additionalTools: [fixtureTool] });
      const bytes = await readFile(target).catch(() => Buffer.alloc(0));
      const calls = run.toolInvocations ?? [];
      const validationFailure = calls.some((call) => call.status === 'validation_failed' && call.errorKind === 'input_validation');
      const oraclePassed = validationFailure && actualExecutions === 1 && bytes.toString('utf8') === 'verified-output';
      await report(id, {
        executionLayer: 'Runner/Harness/ToolExecutionService with scripted Provider and fixture-only additional Tool', provider: { type: 'scripted', simulated: true, physicalUsage: 'unavailable' },
        runId: run.runId, runtimeStatus: run.status, runtimeFinalStatus: run.runtimeStatus ?? null, modelRequests: model.requestCount(), toolCalls: calls.length, actualToolExecutions: actualExecutions,
        validationFeedbackObservedByProvider: calls.some((call) => call.status === 'validation_failed' && call.errorKind === 'input_validation') && model.requestCount() >= 2,
        invocationEvidence: calls.map((call) => ({ toolName: call.toolName, status: call.status, errorKind: call.errorKind })),
        oracle: { status: oraclePassed ? 'passed' : 'failed', taskResult: oraclePassed ? 'passed' : 'failed', method: 'Independent read-back plus invocation ledger verifies invalid proposal had zero effects and corrected proposal had one effect', validationFailureRecorded: validationFailure, actualExecutions, contentMatches: bytes.toString('utf8') === 'verified-output', evidence: [{ path: 'result.txt', sha256: sha256(bytes), bytes: bytes.byteLength }] },
        userInterventions: { approvals: 0, continuePrompts: 0 }, usage: { status: 'unavailable', inputTokens: null, outputTokens: null, cost: null },
        elapsedMs: Math.round(performance.now() - env.started), startedAt: env.startedAt, endedAt: new Date().toISOString(), infrastructureStatus: 'executed',
      });
      return;
    }

    const env = await setup(id);
    const model = queuedLlm([
      responseForTool('multi-write-a', 'write', { file_path: 'a.txt', content: 'hello' }),
      responseForTool('multi-write-b', 'write', { file_path: 'b.txt', content: 'goodbye' }),
      responseForTool('multi-check-a', 'runtime_check_file_content', { file_path: 'a.txt' }),
      responseForTool('multi-check-b', 'runtime_check_file_content', { file_path: 'b.txt' }),
      text('Both requested files were created and checked.'),
    ]);
    const runner = await startRunner(`s3a/${id}`, model.llm);
    const run = await runner.run({ text: '创建 a.txt，内容必须为 hello。\n创建 b.txt，内容必须为 world。', cwd: env.workspace, origin: 'test', approve: async () => true, permissionPreset: 'workspace-write', permissionPolicyV2: runPermission(env.workspace) });
    const a = await readFile(join(env.workspace, 'a.txt')).catch(() => Buffer.alloc(0));
    const b = await readFile(join(env.workspace, 'b.txt')).catch(() => Buffer.alloc(0));
    const outcome = run.taskOutcome;
    const oraclePassed = a.toString('utf8') === 'hello' && b.toString('utf8') === 'goodbye'
      && outcome?.requirements?.map((requirement) => requirement.status).join(',') === 'passed,failed'
      && outcome.status === 'partially_completed';
    await report(id, {
      executionLayer: 'Runner/Harness/Tools with scripted Provider; real writes and run-scoped file-content checkers', provider: { type: 'scripted', simulated: true, physicalUsage: 'unavailable' },
      runId: run.runId, runtimeStatus: run.status, runtimeFinalStatus: run.runtimeStatus ?? null, modelRequests: model.requestCount(), toolCalls: run.toolInvocations?.length ?? null,
      oracle: { status: oraclePassed ? 'passed' : 'failed', taskResult: oraclePassed ? 'partially_completed' : 'failed', method: 'Independent file read-back plus persisted requirement statuses; oracle confirms partial delivery instead of overall success', taskOutcomeStatus: outcome?.status ?? 'unknown', requirementStatuses: outcome?.requirements?.map((requirement) => requirement.status) ?? [], requirementInventory: outcome?.requirementInventory ?? 'unknown', invocationEvidence: run.toolInvocations?.map((call) => ({ toolName: call.toolName, status: call.status, errorKind: call.errorKind })) ?? [], evidence: [
        { path: 'a.txt', sha256: sha256(a), bytes: a.byteLength }, { path: 'b.txt', sha256: sha256(b), bytes: b.byteLength },
      ] },
      userInterventions: { approvals: 0, continuePrompts: 0 }, usage: { status: 'unavailable', inputTokens: null, outputTokens: null, cost: null },
      elapsedMs: Math.round(performance.now() - env.started), startedAt: env.startedAt, endedAt: new Date().toISOString(), infrastructureStatus: 'executed',
    });
  });
});
