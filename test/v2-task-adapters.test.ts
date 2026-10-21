// Controlled-provider adapters for the four R4-B V2 tasks.
//
// The file is inert unless V2_TASK_ID is set: the V2 evaluator spawns exactly
// one task per child vitest process (same pattern as the S3A/S3B adapters).
// It reuses the real Runner/Harness/ToolExecutionService and a scripted
// provider, seeds only the task's declared fixtures, and writes the workspace
// snapshot plus injection/effect facts for the shared oracle module.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm';
import { createRunner } from '@littlesheep/runner';
import type { AgentTool } from '@littlesheep/types';
import { loadTaskSuite, taskById } from '../scripts/lib/r4b/tasks.mjs';
import { evaluateTask } from '../scripts/lib/r4b/oracles.mjs';

const taskId = process.env.V2_TASK_ID ?? '';
const variant = process.env.V2_VARIANT ?? 'canonical';
const faultMode = process.env.V2_FAULT_MODE ?? 'inject';
const taskRoot = process.env.V2_TASK_ROOT ?? '';
const observationPath = process.env.V2_OBSERVATION_PATH ?? '';

let root = '';
const runners: Array<{ shutdown(): Promise<void> }> = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.shutdown().catch(() => undefined);
  delete process.env.LITTLESHEEP_DATA_DIR;
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => undefined);
});

function responseForTool(id: string, name: string, args: unknown): ChatResponse {
  return {
    content: '',
    finishReason: 'tool_calls',
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

function toolFeedbackSeen(request: ChatRequest): boolean {
  return request.messages.some((message) => message.role === 'tool'
    && /runtime_schema|input_validation|validation/i.test(String(message.content)));
}

function toolSucceeded(request: ChatRequest, marker = 'fixture file written'): boolean {
  return request.messages.some((message) => message.role === 'tool' && String(message.content).includes(marker));
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

async function setup(task) {
  root = taskRoot || await mkdtemp(join(tmpdir(), `ls-v2-${taskId.toLowerCase()}-`));
  const workspace = join(root, 'workspace');
  const dataDir = join(root, 'runtime-data');
  await mkdir(workspace, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(task.seed)) {
    const absolute = join(workspace, ...relativePath.split('/'));
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, String(content), 'utf8');
  }
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  return { workspace, dataDir, startedAt: new Date().toISOString(), started: performance.now() };
}

async function snapshotWorkspace(workspace: string) {
  const files = (await readdir(workspace)).filter((name) => !name.startsWith('.')).sort();
  const contents: Record<string, string> = {};
  for (const file of files) contents[file] = await readFile(join(workspace, file), 'utf8');
  return { files, contents };
}

function fixtureTool(workspace: string) {
  const counter = { executions: 0 };
  const tool: AgentTool = {
    name: 'fixture_write_exact',
    description: 'Write one text file inside the isolated evaluation workspace.',
    inputSchema: z.object({ path: z.string(), content: z.string() }).strict(),
    execution: { concurrency: 'exclusive', resources: () => [{ key: 'workspace:result.txt', mode: 'write' }] },
    async execute(input) {
      const args = input as { path: string; content: string };
      if (args.path !== 'result.txt') return { callId: '', ok: false, error: 'fixture path is outside task contract' };
      counter.executions += 1;
      await writeFile(join(workspace, 'result.txt'), args.content, 'utf8');
      return { callId: '', ok: true, output: 'fixture file written' };
    },
  };
  return { tool, counter };
}

const canonicalJson = `${JSON.stringify({ total: 5, items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 3 }] }, null, 2)}\n`;
const wrongFieldJson = `${JSON.stringify({ total_quantity: 5, items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 3 }] }, null, 2)}\n`;

describe.skipIf(!taskId)('V2 controlled task adapter', () => {
  it(`V2 ${taskId}`, async () => {
    expect(observationPath, 'V2_OBSERVATION_PATH is required').toBeTruthy();
    const loaded = loadTaskSuite();
    const task = taskById(loaded, taskId);
    const env = await setup(task);
    let successfulExecutions = 0;
    let duplicateSuccessfulEffects = 0;
    let scripted;
    const additionalTools: AgentTool[] = [];

    if (taskId.startsWith('FILE-02')) {
      const summary = variant === 'wrong-field' ? wrongFieldJson : canonicalJson;
      scripted = scriptedLlm((request, call) => {
        if (call === 1) return responseForTool('read-inventory', 'read', { file_path: 'inventory.csv' });
        if (call === 2) return responseForTool('write-summary', 'write', { file_path: 'inventory-summary.json', content: summary });
        return text('The inventory summary was written.');
      });
    } else if (taskId === 'DELIV-01-G') {
      const fixture = fixtureTool(env.workspace);
      additionalTools.push(fixture.tool);
      scripted = scriptedLlm((request, call) => {
        if (call === 1) return responseForTool('write-result', 'fixture_write_exact', { path: 'result.txt', content: 'verified-output' });
        if (toolSucceeded(request) && call === 2) return text('Wrote the requested file.');
        return text('The requested file was written.');
      });
      const originalExecute = fixture.tool.execute;
      fixture.tool.execute = async (input) => {
        const result = await originalExecute(input);
        successfulExecutions += 1;
        return result;
      };
    } else if (taskId === 'DELIV-01-R') {
      const fixture = fixtureTool(env.workspace);
      additionalTools.push(fixture.tool);
      const originalExecute = fixture.tool.execute;
      fixture.tool.execute = async (input) => {
        const result = await originalExecute(input);
        successfulExecutions += 1;
        return result;
      };
      scripted = scriptedLlm((request, call) => {
        if (faultMode === 'none') {
          if (call === 1) return responseForTool('write-valid', 'fixture_write_exact', { path: 'result.txt', content: 'verified-output' });
          return text('Wrote the requested file without a validation error.');
        }
        if (call === 1) {
          return responseForTool('write-invalid', 'fixture_write_exact', { filepath: 'result.txt', content: 'verified-output' });
        }
        if (task?.faultFixture?.maxInjectedFailures && call > 1 && !toolFeedbackSeen(request) && !toolSucceeded(request)) {
          return text('Stopped without tool feedback.');
        }
        if (faultMode === 'no-recovery') return text('Could not recover from the parameter error.');
        if (toolFeedbackSeen(request) && !toolSucceeded(request)) {
          return responseForTool('write-corrected', 'fixture_write_exact', { path: 'result.txt', content: 'verified-output' });
        }
        if (faultMode === 'duplicate' && call === 3 && toolSucceeded(request, 'fixture file written')) {
          return responseForTool('write-duplicate', 'fixture_write_exact', { path: 'result.txt', content: 'verified-output' });
        }
        return text('Recovered from the parameter error and wrote the file.');
      });
    } else {
      throw new Error(`Unsupported V2 task ${taskId}`);
    }

    expect(scripted).toBeTruthy();
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: `v2/${taskId}`,
      llm: scripted.llm,
      skillsDirs: [],
    });
    runners.push(runner);
    const run = await runner.run({
      text: task.userInput,
      cwd: env.workspace,
      origin: 'test',
      approve: async () => true,
      permissionPreset: 'workspace-write',
      permissionPolicyV2: runPermission(env.workspace),
      additionalTools,
    });
    const snapshot = await snapshotWorkspace(env.workspace);
    const invocations = (run.toolInvocations ?? []).map((invocation) => ({
      toolName: invocation.toolName,
      status: invocation.status,
      errorKind: invocation.errorKind,
      callId: invocation.callId,
    }));
    const settledSideEffects = (run.sideEffects ?? []).filter((effect) => effect.status === 'succeeded').length;
    duplicateSuccessfulEffects = Math.max(0, successfulExecutions - Number(task.goalRules.requiredSuccessfulExecutions ?? 0));
    const dimensions = evaluateTask(task, {
      files: snapshot.files,
      contents: snapshot.contents,
      successfulExecutions,
      duplicateSuccessfulEffects,
      invocations,
    });
    const observation = {
      schemaVersion: 2,
      taskId,
      taskVersion: task.version,
      taskDefinitionSha256: task.taskDefinitionSha256,
      suiteSha256: loaded.suiteSha256,
      observation: {
        dimensions,
        files: snapshot.files,
        successfulExecutions,
        duplicateSuccessfulEffects,
        invocations,
        settledSideEffects,
        variant,
        faultMode,
        userGoal: { text: task.userInput, textSha256: (await import('../scripts/lib/r4b/contract.mjs')).sha256Text(task.userInput) },
        modelConfig: { providerId: 'scripted', simulated: true, wireModelId: null, apiProtocol: null, parameters: { temperature: null, topP: null, seed: null } },
        runtime: {
          runId: run.runId,
          status: run.status,
          runtimeStatus: run.runtimeStatus ?? null,
          modelRequests: scripted.requestCount(),
          toolProposals: (run.toolInvocations ?? []).length,
          toolExecutions: (run.toolInvocations ?? []).filter((invocation) => invocation.status === 'succeeded').length,
          deniedToolCalls: (run.toolInvocations ?? []).filter((invocation) => invocation.status === 'denied' || invocation.status === 'blocked').length,
          failedToolCalls: (run.toolInvocations ?? []).filter((invocation) => invocation.status === 'validation_failed' || invocation.status === 'failed').length,
          settledEffects: settledSideEffects,
          durationMs: Math.round(performance.now() - env.started),
          startedAt: env.startedAt,
          endedAt: new Date().toISOString(),
          infrastructureStatus: 'executed',
          reply: typeof run.reply === 'string' ? run.reply : null,
        },
        safety: { networkPolicy: 'denied', agentNetworkRequests: null, forbiddenRequests: 0, credentialsRedacted: true },
        cleanup: { attempted: true, succeeded: true, residuals: [] },
      },
    };
    await mkdir(join(observationPath, '..'), { recursive: true });
    await writeFile(observationPath, `${JSON.stringify(observation, null, 2)}\n`, 'utf8');
  }, 180_000);
});
