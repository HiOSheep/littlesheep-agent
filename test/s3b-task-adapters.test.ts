import { createServer, type AddressInfo } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG, type Config } from '@littlesheep/config';
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm';
import type { SearchProvider, SearchResponse } from '@littlesheep/types';
import { SearchProviderRegistry } from '../packages/web/src/provider.js';
import type { WebCache } from '../packages/web/src/cache/web-cache.js';
import { createRunner, type AgentRunner, type RunnerResult } from '@littlesheep/runner';
import { z } from 'zod';

const adapterIds = ['RETR-01', 'LONG-01', 'LONG-02', 'DELIV-02'] as const;
const activeRunners: AgentRunner[] = [];
let transientRoot = '';
let fixtureServer: ReturnType<typeof createServer> | undefined;

afterEach(async () => {
  const failures: string[] = [];
  for (const runner of activeRunners.splice(0)) {
    try { await runner.shutdown(); } catch (error) { failures.push(`runner shutdown: ${String(error)}`); }
  }
  if (fixtureServer) {
    const server = fixtureServer;
    fixtureServer = undefined;
    try { await new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose())); }
    catch (error) { failures.push(`fixture server close: ${String(error)}`); }
  }
  if (transientRoot) {
    try { await rm(transientRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch (error) { failures.push(`temporary root cleanup: ${String(error)}`); }
    transientRoot = '';
  }
  delete process.env.LITTLESHEEP_DATA_DIR;
  if (failures.length) throw new Error(`S3B teardown failed: ${failures.join('; ')}`);
});

function responseForTool(id: string, name: string, args: unknown): ChatResponse {
  return { content: '', finishReason: 'tool_calls', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

function text(content = 'The controlled task has ended.'): ChatResponse {
  return { content, toolCalls: [], finishReason: 'stop' };
}

function scriptedLlm(next: (request: ChatRequest, call: number) => ChatResponse) {
  let calls = 0;
  let toolProposals = 0;
  const chat = async (request: ChatRequest) => {
    const response = next(request, ++calls);
    toolProposals += response.toolCalls.length;
    return response;
  };
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
  return { llm, requestCount: () => calls, proposalCount: () => toolProposals };
}

function queuedLlm(responses: ChatResponse[]) {
  return scriptedLlm(() => responses.shift() ?? text('The controlled response sequence is exhausted.'));
}

function sha256(input: string | Buffer) {
  return createHash('sha256').update(input).digest('hex');
}

async function setup(id: string) {
  const requestedRoot = process.env.S3B_TASK_ROOT;
  transientRoot = requestedRoot || await mkdtemp(join(tmpdir(), `ls-s3b-${id.toLowerCase()}-`));
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

function longTaskConfig(): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  config.agents.defaults.maxModelCallsPerRun = 64;
  config.agents.defaults.maxToolCallsPerRun = 64;
  // One segment retains the production 30-turn ceiling; the explicit Run total is 60.
  config.agents.defaults.maxToolLoopIterationsPerRun = 60;
  return config;
}

async function startRunner(id: string, llm: LlmClient, config: Config = DEFAULT_CONFIG, approve?: () => Promise<boolean>) {
  const runner = await createRunner({ config, branding: DEFAULT_BRANDING, model: `s3b/${id}`, llm, skillsDirs: [], ...(approve ? { approve } : {}) });
  activeRunners.push(runner);
  return runner;
}

async function report(id: string, observation: Record<string, unknown>) {
  const path = process.env.S3B_OBSERVATION_PATH;
  if (!path) throw new Error('S3B_OBSERVATION_PATH is required by the evaluation runner.');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, taskId: id, observation }, null, 2)}\n`, 'utf8');
}

function webConfig(): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  config.web.enabled = true;
  config.web.readMode = 'public_anonymous';
  config.web.defaultProvider = 's3b-loopback';
  config.web.providers = [{ id: 's3b-loopback', type: 'tavily-search-v1', apiKeyRef: '$PATH', options: {} }];
  config.web.maxQueriesPerRun = 1;
  config.web.maxFetchesPerRun = 0;
  config.web.maxConcurrentRequests = 1;
  return config;
}

describe('S3B controlled Runner/Harness task adapters', () => {
  it.each(adapterIds)('S3B %s uses the real Runner path and an independent task Oracle', async id => {
    if (process.env.S3B_TASK_ID !== id) return;

    if (id === 'RETR-01') {
      const env = await setup(id);
      const sourcePath = join(env.workspace, 'src', 'client.mjs');
      await mkdir(join(env.workspace, 'src'), { recursive: true });
      await writeFile(sourcePath, "export const apiVersion = 'v1';\n", 'utf8');
      let loopbackRequests = 0;
      fixtureServer = createServer(async (request, response) => {
        loopbackRequests += 1;
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/docs') { response.writeHead(404).end(); return; }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ apiVersion: 'v2', source: 's3b synthetic fixture' }));
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        fixtureServer!.once('error', rejectListen);
        fixtureServer!.listen(0, '127.0.0.1', resolveListen);
      });
      const address = fixtureServer.address() as AddressInfo;
      const provider: SearchProvider = {
        id: 's3b-loopback',
        displayName: 'S3B loopback documentation fixture',
        capabilities: { search: true, recency: false, domains: false, language: false, citations: true },
        async search(searchRequest, context): Promise<SearchResponse> {
          const localResponse = await fetch(`http://127.0.0.1:${address.port}/docs?q=${encodeURIComponent(searchRequest.query)}`, { signal: context.signal });
          const fixture = await localResponse.json() as { apiVersion: string };
          const docsUrl = 'https://docs.example.invalid/client-api';
          return {
            version: 1, provider: this.id, query: searchRequest.query,
            results: [{ rank: 1, title: `Client API docs document version ${fixture.apiVersion}`, snippet: `Documented API version ${fixture.apiVersion}`, url: docsUrl, canonicalUrl: docsUrl, citationId: context.citationIdFor!(docsUrl, 1), sourceStatus: 'search_result' }],
            fetchedAt: new Date().toISOString(), cached: false, partial: false, warnings: [],
          };
        },
      };
      const cache: WebCache = {
        get: async () => undefined,
        set: async () => undefined,
        clear: async () => undefined,
        stats: () => ({ entries: 0, bytes: 0, hits: 0, misses: 0 }),
      };
      let readResultObservedBeforeSearch = false;
      let webSearchAvailableAtDecision = false;
      let webSearchProposed = false;
      let writeProposed = false;
      const decisionTrace: string[] = [];
      const model = scriptedLlm(request => {
        const system = request.messages.map(message => String(message.content)).join('\n');
        const toolMessages = request.messages.filter(message => message.role === 'tool');
        const toolResults = toolMessages.map(message => String(message.content));
        const toolNames = request.tools?.map(tool => tool.function.name) ?? [];
        if (system.includes('Choose the next LittleSheep activity')) {
          return text('{"activity":"execute","confidence":0.99,"reason":"inspect the local compatibility source"}');
        }
        if (system.includes('You are the DECIDE stage')) {
          return text(JSON.stringify({
            assessment: { userNeed: 'resolve the local adapter compatibility mismatch', complexity: 'simple', goal: 'inspect the adapter and update it only if local documentation is insufficient', successCriteria: ['the implementation reflects the documented API version when needed'], missingInfo: [], needsClarification: false, requiresTaskBook: true },
            taskBook: { goal: 'resolve the local adapter compatibility mismatch', complexity: 'simple', successCriteria: ['the implementation reflects the documented API version when needed'], steps: [{ id: 'local-discovery', title: 'Inspect local adapter', description: 'Read the current local API version.', tools: ['read'], requiresApproval: false, acceptanceCriteria: ['current local version is known'], expectedOutput: 'local API version' }] },
          }));
        }
        if (system.includes('You are the final response assembler')) return text('Updated the local adapter to the documented API version.');
        if (system.includes('You are the VERIFY stage')) return text('{"verdict":"pass","reason":"the local adapter matches the independently checked public fixture version","failedStepIds":[],"usedMemoryAtomIds":[]}');
        if (system.includes('You are the EVOLVE stage')) return text('{"memories":[],"reconciliations":[],"reparents":[],"subtreeMoves":[],"revisions":[],"corrections":[],"createSkill":null}');
        if (system.includes('You are the CAPTURE stage')) return text('{"observations":[]}');

        const hasLocalV1 = toolMessages.some(message => message.name === 'read' && String(message.content).includes("apiVersion") && String(message.content).includes('v1'));
        const hasSearchResult = toolMessages.some(message => message.name === 'web_search');
        if (hasLocalV1 && !webSearchProposed) {
          readResultObservedBeforeSearch = true;
          webSearchAvailableAtDecision = toolNames.includes('web_search');
          webSearchProposed = true;
          decisionTrace.push('execute-after-local-v1:web_search');
          return responseForTool('retr-query', 'web_search', { query: 'client API compatibility version', maxResults: 1 });
        }
        if (hasSearchResult && !writeProposed) {
          writeProposed = true;
          decisionTrace.push('execute-after-search-v2:write');
          return responseForTool('retr-update', 'write', { file_path: 'src/client.mjs', content: "export const apiVersion = 'v2';\n" });
        }
        if (writeProposed) return text('Updated the local adapter after consulting the provided documentation fixture.');
        if (toolNames.includes('read')) return responseForTool('retr-local-read', 'read', { file_path: 'src/client.mjs' });
        return text('No additional action was needed.');
      });
      let approvals = 0;
      const runner = await startRunner(id, model.llm, webConfig(), async () => { approvals += 1; return true; });
      runner.infra.webProviders = new SearchProviderRegistry([provider]);
      runner.infra.webCache = cache;
      const run = await runner.run({
        text: 'Inspect the local adapter fixture. If its documented API version is insufficient to resolve the compatibility mismatch, consult the provided documentation fixture and update the local implementation to the documented version.',
        cwd: env.workspace, origin: 'test', permissionPreset: 'workspace-write', permissionPolicyV2: runPermission(env.workspace),
      });
      const bytes = await readFile(sourcePath);
      const actual = execFileSync(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(pathToFileURL(sourcePath).href)}); process.stdout.write(m.apiVersion);`], { cwd: env.workspace, encoding: 'utf8' });
      const webProposalCount = decisionTrace.filter(item => item === 'execute-after-local-v1:web_search').length;
      const passed = actual === 'v2' && loopbackRequests === 1 && run.status === 'ok'
        && readResultObservedBeforeSearch && webSearchAvailableAtDecision && webProposalCount === 1;
      await report(id, {
        executionLayer: 'Runner/Harness/Tools with scripted Provider, built-in web_search and a test-owned HTTP service restricted to 127.0.0.1',
        provider: { type: 'scripted', simulated: true, physicalUsage: 'unavailable' }, runId: run.runId,
        runtimeStatus: run.status, modelRequests: model.requestCount(), toolCallProposals: model.proposalCount(),
        toolExecutions: run.toolInvocations?.filter(item => item.status === 'succeeded').length ?? null,
        deniedToolCalls: run.toolInvocations?.filter(item => item.status === 'denied' || item.status === 'blocked').length ?? null,
        settledEffects: run.sideEffects?.filter(item => item.status === 'succeeded').length ?? null,
        invocationEvidence: run.toolInvocations?.map(item => ({ toolName: item.toolName, status: item.status, errorKind: item.errorKind })) ?? [],
        effectEvidence: run.sideEffects?.map(item => ({ toolName: item.toolName, status: item.status, idempotencyKey: item.idempotencyKey })) ?? [],
        modelDecisionEvidence: { decisionTrace, readResultObservedBeforeSearch, webSearchAvailableAtDecision },
        network: { loopbackRequests, externalAgentRequests: 0, webEvidence: run.webEvidence?.citationCount ?? null },
        approvals: { count: approvals, source: 'fixture-local Runner approve callback' },
        oracle: { status: passed ? 'passed' : 'failed', taskResult: passed ? 'passed' : 'failed', method: 'The scripted Provider observes local v1 through an executed read before proposing web_search; an independent Node import verifies the written v2 export, and the loopback HTTP counter verifies exactly one controlled retrieval', expected: 'v2', actual, evidence: [{ path: 'src/client.mjs', sha256: sha256(bytes), bytes: bytes.byteLength }, 'loopback://docs requestCount=1'] },
        usage: { status: 'unavailable', inputTokens: null, outputTokens: null, cachedInputTokens: null, source: null },
        cost: { status: 'unavailable', value: null, source: null, reason: 'controlled Provider' },
        elapsedMs: Math.round(performance.now() - env.started), startedAt: env.startedAt, endedAt: new Date().toISOString(),
      });
      return;
    }

    if (id === 'LONG-01') {
      const env = await setup(id);
      const outputDir = join(env.workspace, 'outputs');
      await mkdir(outputDir, { recursive: true });
      const items = Array.from({ length: 35 }, (_, index) => `item-${String(index + 1).padStart(2, '0')}`);
      const executed: string[] = [];
      const duplicates: string[] = [];
      const itemTool = {
        name: 'fixture_process_item',
        description: 'Process exactly one declared synthetic item and save its stable output.',
        inputSchema: z.object({ itemId: z.string(), content: z.string() }).strict(),
        execution: { concurrency: 'exclusive' as const, resources: (input: unknown) => [{ key: `s3b:item:${(input as { itemId: string }).itemId}`, mode: 'write' as const }] },
        async execute(input: unknown) {
          const { itemId, content } = input as { itemId: string; content: string };
          if (!items.includes(itemId)) return { callId: '', ok: false, error: 'item is outside the synthetic task set' };
          if (executed.includes(itemId)) duplicates.push(itemId);
          else executed.push(itemId);
          await writeFile(join(outputDir, `${itemId}.txt`), `${content}\n`, 'utf8');
          return { callId: '', ok: true, output: `processed:${itemId}` };
        },
      };
      const model = scriptedLlm(request => {
        const prompt = request.messages.map(message => String(message.content)).join('\n');
        if (prompt.includes('Choose the next LittleSheep activity')) {
          return text('{"type":"problem","confidence":0.99,"reason":"deterministic S3B continuity control"}');
        }
        // This deterministic Provider fixture advances only when the trusted tool
        // callback records a completed item. It models a controlled response
        // sequence for Runtime continuity, not what an open-ended model can infer.
        const next = items[executed.length];
        if (!next) return text('All declared synthetic entries were processed.');
        return responseForTool(`long-${next}`, 'fixture_process_item', { itemId: next, content: `output:${next}` });
      });
      const runner = await createRunner({ config: longTaskConfig(), branding: DEFAULT_BRANDING, model: `s3b/${id}`, llm: model.llm, approve: async () => true, skillsDirs: [] });
      activeRunners.push(runner);
      const run = await runner.run({ text: 'Process the declared 35 synthetic entries into one output per entry, then report any entries that remain.', cwd: env.workspace, origin: 'test', permissionPolicyV2: runPermission(env.workspace), additionalTools: [itemTool] });
      const files = (await readdir(outputDir)).sort();
      const expectedFiles = items.map(item => `${item}.txt`).sort();
      const hashes = await Promise.all(files.map(async file => sha256(await readFile(join(outputDir, file)))));
      const projectionEvents = await runner.infra.durableEventStore.read(run.sessionId, run.runId);
      const checkpointEvents = projectionEvents.filter(event => event.type === 'checkpoint_written');
      const segmentIndexes = new Set<number>();
      for (const event of checkpointEvents) {
        const checkpointId = event.payload.checkpointId;
        if (typeof checkpointId !== 'string') continue;
        const checkpoint = await runner.infra.runCheckpointStore?.read(checkpointId);
        if (checkpoint?.loopBudget.executionSegmentIndex) segmentIndexes.add(checkpoint.loopBudget.executionSegmentIndex);
      }
      const segmentCount = segmentIndexes.size ? Math.max(...segmentIndexes) : null;
      const passed = JSON.stringify(files) === JSON.stringify(expectedFiles) && executed.length === 35 && duplicates.length === 0 && run.status === 'ok' && (segmentCount ?? 0) >= 2;
      await report(id, {
        executionLayer: 'Runner/Harness/Tools with deterministic controlled Provider; Runtime continuity control, not open-ended model quality',
        provider: { type: 'scripted', simulated: true, physicalUsage: 'unavailable' }, runId: run.runId,
        runtimeStatus: run.status, runBudget: { modelCalls: 64, toolCalls: 64, toolLoopIterationsPerRun: 60, segmentLoopCeiling: 30 },
        modelRequests: model.requestCount(), toolCallProposals: model.proposalCount(),
        toolExecutions: executed.length, deniedToolCalls: run.toolInvocations?.filter(item => item.status === 'denied' || item.status === 'blocked').length ?? null,
        settledEffects: run.sideEffects?.filter(item => item.status === 'succeeded').length ?? null,
        runtimeError: run.error ?? null,
        stageTrace: run.trace.map(stage => ({ name: stage.name, ok: stage.ok })),
        segmentsObserved: segmentCount,
        checkpointSegmentIndexes: [...segmentIndexes].sort((left, right) => left - right), checkpointCount: checkpointEvents.length,
        duplicates: duplicates.length,
        oracle: { status: passed ? 'passed' : 'failed', taskResult: passed ? 'passed' : 'failed', method: 'Independent directory listing and file hashes compared against the fixed 35-item set; effect execution IDs and the maximum persisted checkpoint Segment index are tracked', expectedCount: 35, actualCount: files.length, uniqueExecutedItems: executed.length, duplicateItems: duplicates, segmentCount, checkpointSegmentIndexes: [...segmentIndexes].sort((left, right) => left - right), sha256: hashes },
        usage: { status: 'unavailable', inputTokens: null, outputTokens: null, cachedInputTokens: null, source: null },
        cost: { status: 'unavailable', value: null, source: null, reason: 'controlled Provider' },
        approvals: { status: 'unavailable', reason: 'fixture tool stays within its per-run temporary workspace' },
        elapsedMs: Math.round(performance.now() - env.started), startedAt: env.startedAt, endedAt: new Date().toISOString(),
      });
      return;
    }

    if (id === 'LONG-02') {
      const env = await setup(id);
      const isolatedTemp = join(env.root, 'nested-runner-temp');
      await mkdir(isolatedTemp, { recursive: true });
      const testPath = resolve('packages/runner/src/durable-runner-segment-recovery.test.ts');
      const child = spawnSync(process.execPath, [
        resolve('node_modules/vitest/vitest.mjs'), 'run', testPath,
        '--pool=threads', '--maxWorkers=1', '--minWorkers=1',
      ], {
        cwd: resolve('.'), encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, TMP: isolatedTemp, TEMP: isolatedTemp, TMPDIR: isolatedTemp },
      });
      const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
      const statusLine = /Tests\s+1 passed/u.test(output) && /same-Run segment recovery after process restart/u.test(output);
      const passed = child.status === 0 && statusLine;
      const residuals = (await readdir(isolatedTemp)).filter(entry => entry.startsWith('ls-s2b-segment-restart-'));
      await report(id, {
        executionLayer: 'Nested real Runner child-process restart test; controlled Provider; child is SIGKILLed at a safe persisted Segment boundary, then a new Runner recovers the same Run',
        provider: { type: 'scripted', simulated: true, physicalUsage: 'unavailable' }, runId: 's2b-t04a-process-restart',
        runtimeStatus: passed ? 'completed' : child.status === null ? 'unknown' : 'error',
        // The nested integration test asserts these counts but does not export
        // per-invocation records to this adapter, so aggregate counters stay unavailable.
        modelRequests: null, toolCallProposals: null, toolExecutions: null, deniedToolCalls: null, settledEffects: null,
        process: { childExitCode: child.status, killedBySigkill: true, testOutputSha256: sha256(output), rawOutputRetained: false },
        oracle: { status: passed ? 'passed' : 'failed', taskResult: passed ? 'passed' : 'failed', method: 'Existing production Runner recovery integration test performs SIGKILL, creates a new Runner, verifies same Run ID, 35 unique write effects, 36 settled effects, final outcome and released lease', evidence: ['packages/runner/src/durable-runner-segment-recovery.test.ts::same-Run segment recovery after process restart'], outputMatchedIndependentTestPass: statusLine },
        usage: { status: 'unavailable', inputTokens: null, outputTokens: null, cachedInputTokens: null, source: null },
        cost: { status: 'unavailable', value: null, source: null, reason: 'controlled Provider' },
        approvals: { status: 'unavailable', reason: 'integration test uses fixture-owned approval callback' },
        cleanup: { attempted: true, succeeded: residuals.length === 0, residuals },
        elapsedMs: Math.round(performance.now() - env.started), startedAt: env.startedAt, endedAt: new Date().toISOString(),
      });
      expect(passed, `Runner recovery test failed; output sha256=${sha256(output)}`).toBe(true);
      expect(residuals).toEqual([]);
      return;
    }

    const env = await setup(id);
    const target = join(env.workspace, 'result.txt');
    const model = queuedLlm([
      responseForTool('deliv2-write', 'write', { file_path: 'result.txt', content: 'goodbye' }),
      text('Created result.txt with exactly hello and checked the file. The task is complete.'),
    ]);
    const runner = await startRunner(id, model.llm);
    const run: RunnerResult = await runner.run({ text: 'Create result.txt containing exactly hello and independently check the file contents before you say it is complete.', cwd: env.workspace, origin: 'test', permissionPreset: 'workspace-write', permissionPolicyV2: runPermission(env.workspace) });
    const bytes = await readFile(target).catch(() => Buffer.alloc(0));
    const outcome = run.taskOutcome;
    const check = outcome?.requirements?.[0];
    const checkerInvoked = run.toolInvocations?.some(item => item.toolName === 'runtime_check_file_content' && item.status === 'succeeded') ?? false;
    const falseCompletionClaim = /complete|created|exactly hello/iu.test(run.reply ?? '')
      && bytes.toString('utf8') !== 'hello' && outcome?.status !== 'completed';
    const passed = bytes.toString('utf8') === 'goodbye' && !checkerInvoked && outcome?.status !== 'completed' && falseCompletionClaim;
    await report(id, {
      executionLayer: 'Runner/Harness/Tools with scripted Provider; independent external Oracle detects unsupported completion claim when the exact request grammar does not produce a Runtime requirement checker',
      provider: { type: 'scripted', simulated: true, physicalUsage: 'unavailable' }, runId: run.runId,
      runtimeStatus: run.status, runtimeFinalStatus: run.runtimeStatus ?? null, modelRequests: model.requestCount(),
      toolCallProposals: model.proposalCount(), toolExecutions: run.toolInvocations?.filter(item => item.status === 'succeeded').length ?? null,
      deniedToolCalls: run.toolInvocations?.filter(item => item.status === 'denied' || item.status === 'blocked').length ?? null,
      settledEffects: run.sideEffects?.filter(item => item.status === 'succeeded').length ?? null,
      taskOutcomeStatus: outcome?.status ?? 'unknown', requirementStatus: check?.status ?? 'unverified', checkerInvoked, falseCompletionClaim,
      oracle: { status: passed ? 'passed_failure_detected' : 'failed', evaluationCheck: passed ? 'passed' : 'failed', taskResult: 'failed', failureAttribution: passed ? { primary: 'insufficient_verification', secondary: ['strict_requirement_parser_did_not_recognize_task_text'], evidenceRefs: ['result.txt', 'TaskOutcome inventory unknown', 'no Runtime file checker invocation'], confidence: 'high' } : undefined, method: 'Independent disk read compares actual bytes with the user request; invocation records confirm whether the production checker was available; the final reply is checked for an unsupported completion claim', expected: 'hello', actual: bytes.toString('utf8'), requirementStatus: check?.status ?? 'unverified', taskOutcomeStatus: outcome?.status ?? 'unknown', checkerInvoked, falseCompletionClaim, evidence: [{ path: 'result.txt', sha256: sha256(bytes), bytes: bytes.byteLength }] },
      usage: { status: 'unavailable', inputTokens: null, outputTokens: null, cachedInputTokens: null, source: null },
      cost: { status: 'unavailable', value: null, source: null, reason: 'controlled Provider' },
      approvals: { status: 'unavailable', reason: 'no approval request was required by this fixture path' },
      elapsedMs: Math.round(performance.now() - env.started), startedAt: env.startedAt, endedAt: new Date().toISOString(),
    });
  }, 360_000);
});
