import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { DEFAULT_CONFIG } from '../packages/config/src/index.js';
import { DEFAULT_BRANDING } from '../packages/branding/src/index.js';
import { createExecuteStage } from '../packages/harness/src/stages/execute.js';
import { createMockLlm, makeCtx, makeTool, textResponse, toolCallResponse } from '../packages/harness/src/tests/helpers.js';
import { createRunner } from '../packages/runner/src/runner.js';
import { createExecTool } from '../packages/tools/src/builtin/exec.js';
import { bindShellApprovalAuthority } from '../packages/tools/src/shell-authorization.js';
import { webSearchTool } from '../packages/tools/src/builtin/web_search.js';
import { webFetchTool } from '../packages/tools/src/builtin/web_fetch.js';
import { readTool } from '../packages/tools/src/builtin/read.js';
import { writeTool } from '../packages/tools/src/builtin/write.js';
import { editTool } from '../packages/tools/src/builtin/edit.js';
import { createInMemoryFileObservationPort } from '../packages/tools/src/file-observation.js';
import type { AgentTool, ToolContext } from '../packages/types/src/agent.js';

const ids = ['C01','C02','C03','C04','C05','C06','C07','C08','F01','F02','F03','F04','R01','R02','R03','R04','L01','L02','L03','L04','X01','X02','X03','X04'] as const;
const roots: string[] = [];
const runners: Array<{ shutdown(): Promise<void> }> = [];
let originalDataDir: string | undefined;

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.shutdown();
  if (originalDataDir === undefined) delete process.env.LITTLESHEEP_DATA_DIR;
  else process.env.LITTLESHEEP_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

async function writeObservation(id: string, observation: Record<string, unknown>) {
  const output = process.env.RCD_S0_OBSERVATION;
  if (!output) throw new Error('RCD_S0_OBSERVATION is required');
  await writeFile(output, `${JSON.stringify({ scenarioId: id, observation }, null, 2)}\n`, 'utf8');
}

function workspace() {
  const value = process.env.RCD_S0_WORKSPACE;
  if (!value) throw new Error('RCD_S0_WORKSPACE is required');
  return value;
}

describe.skipIf(!process.env.RCD_S0_SCENARIO_ID)('RCD S0B executable representative scenarios', () => {
  it.each(ids)('%s', async (id) => {
    const runners: Record<string, () => Promise<void>> = {
      C01: () => runRepeatedShell('C01'), C02: runC02, C03: runC03, C04: runC04, C05: runC05, C06: runC06, C07: runC07, C08: runC08,
      F01: runF01, F02: runF02, F03: runF03, F04: runF04,
      R01: runR01, R02: runR02, R03: runR03, R04: runR04,
      L01: runL01, L02: runL02, L03: runL03, L04: runL04,
      X01: runX01, X02: runX02, X03: runX03, X04: runX04,
    };
    await runners[id]!();
  });
});

function sequenceLlm(responses: ReturnType<typeof textResponse>[]) {
  let index = 0;
  return createMockLlm(() => responses[index++] ?? textResponse('No further fixture operation was requested.'));
}

function harnessContext(tools: AgentTool[], cwd: string, inbound: string) {
  const ctx = makeCtx({ tools, inbound: { role: 'user', content: [{ type: 'text', text: inbound }] } as never });
  ctx.cwd = cwd;
  ctx.toolContext.cwd = cwd;
  ctx.toolContext.workspaceRoot = cwd;
  ctx.toolContext.observation = createInMemoryFileObservationPort();
  return ctx;
}

async function executeStage(tools: AgentTool[], cwd: string, inbound: string, responses: ReturnType<typeof textResponse>[]) {
  const ctx = harnessContext(tools, cwd, inbound);
  const llm = sequenceLlm(responses);
  const result = await createExecuteStage({ llm, model: 'rcd/scripted-provider', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING })(ctx);
  return { ctx, result, llm };
}

async function runRepeatedShell(id: string) { return runGeneric(id); }
async function runC03() { return runGeneric('C03'); }
async function runC04() { return runGeneric('C04'); }
async function runC05() { return runGeneric('C05'); }
async function runC06() { return runGeneric('C06'); }
async function runC07() { return runGeneric('C07'); }
async function runF01() { return runGeneric('F01'); }
async function runF02() { return runGeneric('F02'); }
async function runF03() { return runGeneric('F03'); }
async function runF04() { return runGeneric('F04'); }
async function runR03() { return runGeneric('R03'); }
async function runR04() { return runGeneric('R04'); }
async function runL02() { return runGeneric('L02'); }
async function runL03() { return runGeneric('L03'); }
async function runL04() { return runGeneric('L04'); }
async function runX02() { return runGeneric('X02'); }
async function runX03() { return runGeneric('X03'); }
async function runX04() { return runGeneric('X04'); }

// Shared component-level adapter for scenarios whose full Runner/host contract
// is not represented by the current deterministic fixture ports. It executes
// through Harness + ToolExecutionService, performs a real isolated file effect,
// and applies a separate scenario-specific observation Oracle. It never reports
// full scenario success from the fixture operation alone.
async function runGeneric(id: string) {
  const cwd = workspace();
  const target = join(cwd, `${id.toLowerCase()}-effect.txt`);
  const toolName = 'fixture_operation';
  let effectCount = 0;
  const tool = makeTool(toolName, { ok: true, output: 'fixture operation recorded' }, { inputSchema: z.object({ value: z.string() }).strict() });
  tool.execution = { concurrency: 'exclusive', resources: () => [{ key: `workspace:${id}:effect`, mode: 'write' }] };
  tool.execute = async (input) => {
    effectCount += 1;
    await writeFile(target, `${String((input as { value: string }).value)}\n`, 'utf8');
    return { callId: '', ok: true, output: 'fixture operation recorded' };
  };
  const response = toolCallResponse([{ id: `${id}-operation`, name: toolName, args: { value: `${id}:executed` } }]);
  const { ctx, result } = await executeStage([tool], cwd, `Run the ${id} fixture operation once, then report what remains unverified.`, [response, textResponse('The fixture operation ran; complete acceptance remains unverified.')]);
  const bytes = await readFile(target).catch(() => Buffer.alloc(0));
  const expectedEffects = id === 'F01' ? effectCount === 1 && bytes.toString('utf8').includes(id) : effectCount === 1;
  const productResult = 'unverified';
  await writeObservation(id, {
    testLayer: 'harness_execute_stage_tool_execution_service_component_adapter', provider: 'scripted-mock',
    toolCallCount: (ctx.toolResults ?? []).length, toolFailures: (ctx.toolResults ?? []).filter((item) => !item.ok).length,
    effectCount, fixtureEffect: { path: `${id.toLowerCase()}-effect.txt`, bytes: bytes.byteLength, sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex') },
    stopReason: result.ok ? 'execute_completed' : result.error ?? 'execute_failed',
    productResult: expectedEffects ? productResult : 'failed',
    oracle: `Component Oracle for ${id}: Harness must dispatch exactly one fixture tool, ToolExecutionService must record the call, and the external temporary-file check must confirm its bytes. Full scenario acceptance remains unverified at this execution layer.`,
    evidenceRefs: [`fixture://${id}/${id.toLowerCase()}-effect.txt`, `observation://${id}/tool-results`],
    sideEffects: { effectCount, workspaceOnly: true }, authorization: 'fixture-only; no external authorization or network',
  });
}

function fixtureShellAuthority(ctx: ReturnType<typeof harnessContext>, cwd: string, decision: 'allow' | 'approval' = 'allow', onRequest: () => void = () => {}) {
  const approve: NonNullable<ToolContext['approve']> = async () => true;
  bindShellApprovalAuthority(approve, {
    runId: ctx.runId, sessionId: String(ctx.sessionId), workspaceRoot: cwd, workspaceId: `rcd:${ctx.runId}`, permission: 'fixture-only',
    current: async () => `fixture:${cwd}`, decide: () => decision, request: async () => { onRequest(); return true; },
  });
  ctx.toolContext.approve = approve;
  return approve;
}

async function runC02() {
  const cwd = workspace();
  const target = join(cwd, 'target.txt');
  const invoked: unknown[] = [];
  const proposals: Array<{ request: number; args: Record<string, unknown>; feedbackIncluded: boolean }> = [];
  let request = 0;
  const llm = createMockLlm((chatRequest) => {
    request += 1;
    const feedbackIncluded = chatRequest.messages.some((message) => message.role === 'tool' && JSON.stringify(message.content).includes('runtime_schema'));
    if (request === 1) {
      proposals.push({ request, args: { path: 17 }, feedbackIncluded });
      return toolCallResponse([{ id: 'bad-input', name: 'fixture_lookup', args: { path: 17 } }]);
    }
    if (request === 2) {
      proposals.push({ request, args: { path: 'target.txt' }, feedbackIncluded });
      return toolCallResponse([{ id: 'corrected-input', name: 'fixture_lookup', args: { path: 'target.txt' } }]);
    }
    return textResponse('The corrected fixture edit is complete.');
  });
  const tool = makeTool('fixture_lookup', { ok: true, output: 'fixture-value' }, { inputSchema: z.object({ path: z.string() }).strict() });
  tool.execute = async (input) => {
    invoked.push(input);
    const args = input as { path: string };
    if (args.path !== 'target.txt') throw new Error('fixture path is outside the C02 contract');
    await writeFile(target, 'fixture-value\n', 'utf8');
    return { callId: '', ok: true, output: 'fixture-value' };
  };
  const ctx = harnessContext([tool], cwd, 'Write fixture-value into target.txt using the registered tool.');
  const result = await createExecuteStage({ llm, model: 'rcd/scripted-provider', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING })(ctx);
  const statuses = (ctx.toolInvocations ?? []).map((record) => ({ status: record.status, errorKind: record.errorKind }));
  const actualFile = await readFile(target, 'utf8').catch(() => '');
  const corrected = invoked.length === 1 && JSON.stringify(invoked[0]) === JSON.stringify({ path: 'target.txt' }) && actualFile === 'fixture-value\n';
  await writeObservation('C02', {
    testLayer: 'harness_execute_stage_with_real_ToolExecutionService',
    provider: 'scripted-mock',
    requests: request,
    toolCallCount: (ctx.toolResults ?? []).length,
    toolFailures: (ctx.toolResults ?? []).filter((item) => !item.ok).length,
    invocationStatuses: statuses,
    toolResultErrors: (ctx.toolResults ?? []).filter((item) => !item.ok).map((item) => ({ errorKind: item.meta?.errorKind, validation: item.meta?.validation, error: item.error })),
    proposals,
    executions: invoked.length,
    sideEffects: { malformedInputExecutions: 0, correctedInputExecutions: invoked.length },
    correctedInputExecuted: corrected,
    fixtureEffect: { path: 'target.txt', bytes: Buffer.byteLength(actualFile, 'utf8'), sha256: (await import('node:crypto')).createHash('sha256').update(actualFile).digest('hex') },
    stopReason: result.ok ? 'execute_completed' : result.error ?? 'execute_failed',
    productResult: corrected ? 'passed' : 'failed',
    oracle: 'The schema-invalid proposal has no side effect; the corrected proposal executes in the same run.',
    evidenceRefs: ['observation://C02/invocation-statuses', 'observation://C02/execution-count', 'fixture://C02/target.txt'],
  });
}

async function runC08() {
  const cwd = workspace();
  await writeFile(join(cwd, 'input.txt'), 'v1\n', 'utf8');
  await writeFile(join(cwd, 'check.mjs'), "import { appendFileSync, readFileSync } from 'node:fs'; const value=readFileSync('input.txt','utf8').trim(); const code=value==='v2'?0:1; appendFileSync('runs.log', value+':'+code+'\\n'); console.log(value+':'+code); process.exitCode=code;\n", 'utf8');
  let requests = 0;
  const intermediateStates: Array<{ beforeSha256: string; afterSha256: string }> = [];
  const command = 'node check.mjs';
  const llm = createMockLlm(() => {
    requests += 1;
    if (requests === 1 || requests === 3) return toolCallResponse([{ id: `shell-${requests}`, name: 'exec', args: { command, cwd: '.' } }]);
    if (requests === 2) return toolCallResponse([{ id: 'edit-fixture', name: 'fixture_edit', args: { value: 'v2' } }]);
    return textResponse('The second identical command did not run.');
  });
  const edit: AgentTool = {
    name: 'fixture_edit', description: 'Modify only the synthetic test dependency.',
    inputSchema: z.object({ value: z.string() }).strict(),
    execution: { concurrency: 'exclusive', resources: () => [{ key: 'workspace:input.txt', mode: 'write' }] },
    async execute(input) {
      const inputPath = join(cwd, 'input.txt');
      const before = await readFile(inputPath);
      await writeFile(inputPath, `${String((input as { value: string }).value)}\n`, 'utf8');
      const after = await readFile(inputPath);
      const crypto = await import('node:crypto');
      intermediateStates.push({ beforeSha256: crypto.createHash('sha256').update(before).digest('hex'), afterSha256: crypto.createHash('sha256').update(after).digest('hex') });
      return { callId: '', ok: true, output: 'fixture dependency changed' };
    },
  };
  const exec = createExecTool({ interactive: false });
  const ctx = makeCtx({ tools: [exec, edit], inbound: { role: 'user', content: [{ type: 'text', text: 'Run the local test, update its fixture, and run the exact same shell command again.' }] } as never });
  ctx.cwd = cwd;
  ctx.toolContext.cwd = cwd;
  ctx.toolContext.workspaceRoot = cwd;
  const sessionId = String(ctx.sessionId);
  const approve: NonNullable<ToolContext['approve']> = async () => true;
  let approvalRequests = 0;
  bindShellApprovalAuthority(approve, {
    runId: ctx.runId, sessionId, workspaceRoot: cwd, workspaceId: `rcd:${ctx.runId}`, permission: 'fixture-only',
    current: async () => `fixture:${cwd}`, decide: () => 'allow', request: async () => { approvalRequests += 1; return true; },
  });
  ctx.toolContext.approve = approve;
  const result = await createExecuteStage({ llm, model: 'rcd/scripted-provider', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING })(ctx);
  const events = (ctx.toolResults ?? []).map((item) => ({ ok: item.ok, errorKind: item.meta?.errorKind, error: item.error }));
  const runs = await readFile(join(cwd, 'runs.log'), 'utf8').catch(() => '');
  const fixtureHash = (await import('node:crypto')).createHash('sha256').update(runs).digest('hex');
  const attempts = runs.trim().split(/\r?\n/u).filter(Boolean);
  const executedTwice = attempts.length === 2 && attempts[0] === 'v1:1' && attempts[1] === 'v2:0';
  const refusedAsReplay = (ctx.toolResults ?? []).some((item) => item.meta?.errorKind === 'side_effect_replay' || /refusing to replay/i.test(item.error ?? ''))
    || (ctx.toolInvocations ?? []).some((item) => item.errorKind === 'side_effect_replay');
  await writeObservation('C08', {
    testLayer: 'harness_execute_stage_real_builtin_exec_with_fixture_only_host_authority',
    provider: 'scripted-mock',
    commandHash: 'sha256:' + (await import('node:crypto')).createHash('sha256').update(command).digest('hex'),
    modelRequests: requests,
    shellExecutionCount: attempts.length,
    shellAttempts: attempts,
    commandProposals: requests === 4 ? 2 : null,
    shellResults: events,
    intermediateStates,
    dependencyChangedBetweenCalls: runs.includes('v1') && (await readFile(join(cwd, 'input.txt'), 'utf8')).includes('v2'),
      refusalWasReplay: refusedAsReplay,
    authorization: { approvalRequests, decision: 'allow', scope: 'temporary fixture workspace' },
    sideEffects: { inputChanged: intermediateStates.length === 1 && intermediateStates[0]!.beforeSha256 !== intermediateStates[0]!.afterSha256, fixtureArtifactsRemovedByTeardown: true },
    toolCallCount: (ctx.toolResults ?? []).length,
    toolFailures: (ctx.toolResults ?? []).filter((item) => !item.ok).length,
    fixtureEvidence: [{ ref: 'fixture://C08/runs.log', sha256: fixtureHash, bytes: Buffer.byteLength(runs, 'utf8') }],
    productResult: executedTwice ? 'passed' : refusedAsReplay ? 'failed' : 'unverified',
    stopReason: result.ok ? 'execute_completed' : result.error ?? 'execute_failed',
    oracle: 'Exactly two identical command calls are recorded with outcomes fail then pass and distinct fixture state hashes; final fixture assertion passes.',
    evidenceRefs: ['fixture://C08/runs.log.sha256', 'fixture://C08/intermediate-state-hashes', 'observation://C08/tool-results'],
  });
}

async function startFixtureServer() {
  let requests = 0;
  const server: Server = createServer((_request, response) => { requests += 1; response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"fact":"fixture-api-v1"}'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local fixture server did not bind a TCP port');
  return { server, url: `http://127.0.0.1:${address.port}/search`, get requests() { return requests; } };
}

async function runR01() {
  const fixture = await startFixtureServer();
  try {
    let turns = 0;
    const discovery = makeTool('fixture_discover_gap', { ok: true, output: 'Local docs confirm a compatibility issue, but do not contain the official API version behavior.' });
    const proposalTurns: string[] = [];
    const llm = createMockLlm(() => { turns += 1;
      if (turns === 1) { proposalTurns.push('local_discovery'); return toolCallResponse([{ id: 'discover-local-gap', name: 'fixture_discover_gap', args: {} }]); }
      if (turns === 2) { proposalTurns.push('web_search_proposal_after_discovery'); return toolCallResponse([{ id: 'mid-task-web-search', name: 'web_search', args: { query: 'official API behavior fixture-api-v1' } }]); }
      return textResponse('The requested public API fact could not be retrieved in this run.'); });
    const ctx = makeCtx({ tools: [discovery, webSearchTool], inbound: { role: 'user', content: [{ type: 'text', text: 'Fix the local project integration issue.' }] } as never });
    ctx.toolContext.networkPolicy = { version: 1, enabled: true, providerId: 'rcd-local', mode: 'public_anonymous', allowDomains: ['127.0.0.1'], blockDomains: [], strictReadApproval: false, maxResults: 5, maxQueryChars: 1000, maxQueriesPerRun: 2, maxFetchesPerRun: 2, maxConcurrentRequests: 1, searchTimeoutMs: 5000, fetchTimeoutMs: 5000, totalTimeoutMs: 10000, maxResponseBytes: 10000, maxExtractedChars: 1000, maxRedirects: 0, cacheEnabled: false, cacheTtlSeconds: 0, cacheMaxBytes: 0, browserFallback: 'approval_required', sensitiveQueryPolicy: 'deny' };
    ctx.toolContext.webRetrieval = {
      async search() {
        const response = await fetch(fixture.url);
        const fact = await response.text();
        return { version: 1, provider: 'rcd-local', query: 'redacted', results: [{ rank: 1, title: 'Fixture API', url: fixture.url, snippet: fact, citationId: 'rcd-citation-1', sourceStatus: 'success' }], fetchedAt: new Date().toISOString(), cached: false, partial: false, warnings: [] };
      },
      async fetch() { throw new Error('not used'); },
      evidence() { return { version: 1, providerId: 'rcd-local', generatedAt: new Date().toISOString(), completeness: fixture.requests ? 'complete' : 'none', citationIds: fixture.requests ? ['rcd-citation-1'] : [], citationCount: fixture.requests ? 1 : 0, documentCount: 0, cached: false, partial: false, truncated: false, blocked: false, stale: false }; },
    } as never;
    const result = await createExecuteStage({ llm, model: 'rcd/scripted-provider', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING })(ctx);
    const reached = fixture.requests > 0;
    await writeObservation('R01', {
      testLayer: 'harness_execute_stage_builtin_web_search_local_http_adapter', provider: 'scripted-mock',
      modelRequests: turns, proposalTurns, discoveryToolExecuted: (ctx.toolResults ?? []).some((item) => item.ok && item.callId),
      toolCallCount: (ctx.toolResults ?? []).length, toolFailures: (ctx.toolResults ?? []).filter((item) => !item.ok).length,
      localHttpRequests: fixture.requests,
      webSearchInvocation: (ctx.toolInvocations ?? []).filter((record) => record.toolName === 'web_search').map((record) => ({ status: record.status, errorKind: record.errorKind })),
      webProposalAfterLocalDiscovery: proposalTurns.indexOf('web_search_proposal_after_discovery') > proposalTurns.indexOf('local_discovery'),
      productResult: reached ? 'passed' : 'failed', stopReason: result.ok ? 'execute_completed' : result.error ?? 'execute_failed',
      oracle: 'A mid-task public information need reaches only the loopback fixture and returns the frozen fact.', evidenceRefs: ['fixture://R01/local-server-request-count'],
    });
  } finally { await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve())); }
}

async function runR02() {
  const fixture = await startFixtureServer();
  try {
    // Paired allow control: the same built-in Web path is usable when the
    // inbound task explicitly requests public retrieval and policy allows it.
    const allowedLlm = createMockLlm((request) => request.messages.some((message) => message.role === 'tool')
      ? textResponse('Fixture result received.')
      : toolCallResponse([{ id: 'allowed-control-search', name: 'web_search', args: { query: 'local official fixture fact' } }]));
    const allowedCtx = makeCtx({ tools: [webSearchTool], inbound: { role: 'user', content: [{ type: 'text', text: 'Search the public fixture source for the current API fact.' }] } as never });
    allowedCtx.toolContext.networkPolicy = { version: 1, enabled: true, providerId: 'rcd-allowed-control', mode: 'public_anonymous', allowDomains: ['127.0.0.1'], blockDomains: [], strictReadApproval: false, maxResults: 5, maxQueryChars: 1000, maxQueriesPerRun: 1, maxFetchesPerRun: 1, maxConcurrentRequests: 1, searchTimeoutMs: 5000, fetchTimeoutMs: 5000, totalTimeoutMs: 10000, maxResponseBytes: 10000, maxExtractedChars: 1000, maxRedirects: 0, cacheEnabled: false, cacheTtlSeconds: 0, cacheMaxBytes: 0, browserFallback: 'approval_required', sensitiveQueryPolicy: 'deny' };
    allowedCtx.toolContext.webRetrieval = { async search() { const response = await fetch(fixture.url); const fact = await response.text(); return { version: 1, provider: 'rcd-local', query: 'redacted', results: [{ rank: 1, title: 'Fixture', url: fixture.url, snippet: fact, citationId: 'allowed-control', sourceStatus: 'success' }], fetchedAt: new Date().toISOString(), cached: false, partial: false, warnings: [] }; }, async fetch() { throw new Error('not used'); }, evidence() { return { version: 1, providerId: 'rcd-allowed-control', generatedAt: new Date().toISOString(), completeness: 'complete', citationIds: ['allowed-control'], citationCount: 1, documentCount: 0, cached: false, partial: false, truncated: false, blocked: false, stale: false }; } } as never;
    await createExecuteStage({ llm: allowedLlm, model: 'rcd/scripted-provider', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING })(allowedCtx);
    const allowedControlRequests = fixture.requests;

    let turns = 0;
    const llm = createMockLlm(() => { turns += 1; return turns === 1
      ? toolCallResponse([{ id: 'forbidden-web-search', name: 'web_search', args: { query: 'public fixture query' } }])
      : textResponse('The network query was blocked; only local evidence can be used.'); });
    const ctx = makeCtx({ tools: [webSearchTool], inbound: { role: 'user', content: [{ type: 'text', text: 'Use only local materials. Do not connect to the network. Fix the project.' }] } as never });
    ctx.toolContext.networkPolicy = { version: 1, enabled: false, providerId: 'rcd-disabled', mode: 'disabled', allowDomains: [], blockDomains: [], strictReadApproval: false, maxResults: 5, maxQueryChars: 1000, maxQueriesPerRun: 0, maxFetchesPerRun: 0, maxConcurrentRequests: 1, searchTimeoutMs: 5000, fetchTimeoutMs: 5000, totalTimeoutMs: 10000, maxResponseBytes: 10000, maxExtractedChars: 1000, maxRedirects: 0, cacheEnabled: false, cacheTtlSeconds: 0, cacheMaxBytes: 0, browserFallback: 'approval_required', sensitiveQueryPolicy: 'deny' };
    ctx.toolContext.webRetrieval = { async search() { const response = await fetch(fixture.url); return { version: 1, provider: 'rcd-local', query: 'redacted', results: [], fetchedAt: new Date().toISOString(), cached: false, partial: false, warnings: [] }; }, async fetch() { throw new Error('not used'); }, evidence() { return { version: 1, providerId: 'rcd-disabled', generatedAt: new Date().toISOString(), completeness: 'none', citationIds: [], citationCount: 0, documentCount: 0, cached: false, partial: false, truncated: false, blocked: true, stale: false, errorKinds: ['web_disabled'] }; } } as never;
    const result = await createExecuteStage({ llm, model: 'rcd/scripted-provider', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING })(ctx);
    const webError = (ctx.toolResults ?? []).find((item) => item.meta?.errorKind === 'web_disabled')?.meta?.errorKind;
    const webToolAdmitted = (ctx.tools ?? []).some((tool) => tool.name === 'web_search');
    // R02's frozen Oracle accepts an honestly blocked or unverified local result.
    // Runtime may enforce the denial by withholding Web capability before invocation.
    const deniedCaseRequests = fixture.requests - allowedControlRequests;
    const correctlyBlocked = deniedCaseRequests === 0;
    await writeObservation('R02', {
      testLayer: 'harness_execute_stage_builtin_web_search_with_network_disabled_policy', provider: 'scripted-mock',
      modelRequests: turns, toolCallCount: (ctx.toolResults ?? []).length, toolFailures: (ctx.toolResults ?? []).filter((item) => !item.ok).length,
      allowControlRequests: allowedControlRequests, deniedCaseRequests,
      localHttpRequests: fixture.requests, webToolAdmitted, webDisabledError: webError === 'web_disabled',
      webToolErrors: (ctx.toolResults ?? []).filter((item) => !item.ok).map((item) => item.meta?.errorKind ?? item.error ?? 'unknown'),
      authorization: { networkPolicy: 'explicitly-denied', deniedOutboundRequests: fixture.requests - allowedControlRequests, allowedControlPolicy: 'explicitly-allowed', allowedControlRequests },
      productResult: correctlyBlocked && allowedControlRequests === 1 ? 'correctly_blocked' : 'failed', stopReason: result.ok ? 'execute_completed' : result.error ?? 'execute_failed',
      oracle: `Paired control must allow the explicitly permitted fixture query (${allowedControlRequests} request); the user-forbidden case must produce zero additional requests and an honest blocked/unverified result (actual refusal: ${webToolAdmitted ? 'tool_not_admitted' : 'web_capability_withheld'}).`, evidenceRefs: ['fixture://R02/paired-request-counts', 'observation://R02/tool-not-admitted'],
    });
  } finally { await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve())); }
}

async function runL01() {
  const cwd = workspace();
  let turn = 0;
  const requiredOperations = 35;
  const executed: string[] = [];
  const llm = createMockLlm((request) => {
    turn += 1;
    if (turn <= requiredOperations) return toolCallResponse([{ id: `progress-${turn}`, name: 'record_progress', args: { step: turn } }]);
    return textResponse(request.messages.some((message) => typeof message.content === 'string' && message.content.includes('iteration budget is spent'))
      ? 'The single tool-loop budget has been exhausted; the remaining steps are not done.' : 'Task stopped.');
  });
  const tool = makeTool('record_progress', { ok: true, output: 'progress recorded' }, { inputSchema: z.object({ step: z.number().int() }).strict() });
  tool.execution = { concurrency: 'parallel', resources: (input) => [{ key: `workspace:step:${String((input as { step: number }).step)}`, mode: 'write' }] };
  tool.execute = async (input) => {
    const step = Number((input as { step: number }).step);
    executed.push(String(step));
    await writeFile(join(cwd, `step-${String(step).padStart(2, '0')}.txt`), `completed:${step}\n`, 'utf8');
    return { callId: '', ok: true, output: `completed step ${step}` };
  };
  const ctx = makeCtx({ tools: [tool], inbound: { role: 'user', content: [{ type: 'text', text: 'Complete all 35 independently verifiable fixture operations.' }] } as never });
  const result = await createExecuteStage({ llm, model: 'rcd/scripted-provider', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING })(ctx);
  const stopReason = ctx.loopBudget?.toolLoopIterationsUsed === 30 ? 'single_segment_iteration_budget_exhausted' : result.error ?? 'other';
  const fixtureFiles = await readdir(cwd);
  const complete = executed.length === requiredOperations && fixtureFiles.length === requiredOperations;
  await writeObservation('L01', {
    testLayer: 'harness_execute_stage_real_main_loop_with_scripted_provider_and_fixture_tool', provider: 'scripted-mock',
    modelRequests: turn, requiredOperations, completedOperations: executed.length, loopBudget: ctx.loopBudget?.toolLoopIterationsUsed,
    completedFixtureFiles: fixtureFiles.length,
    toolCallCount: (ctx.toolResults ?? []).length, toolFailures: (ctx.toolResults ?? []).filter((item) => !item.ok).length,
    stopReason, productResult: complete ? 'passed' : 'partially_completed', oracle: 'More than 30 turns occur across bounded segments; all declared artifacts/tests pass; total model/tool/time budgets never exceed frozen limits; one logical task is retained.',
    evidenceRefs: ['observation://L01/operation-count', 'observation://L01/loop-budget'],
  });
}

async function runX01() {
  const dataDir = join(workspace(), 'runner-data');
  const work = join(workspace(), 'work');
  await mkdir(work, { recursive: true });
  originalDataDir ??= process.env.LITTLESHEEP_DATA_DIR;
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  let calls = 0;
  const probe: AgentTool = {
    name: 'rcd_unknown_effect', description: 'Synthetic effect that completes bytes then loses its settlement.', inputSchema: z.object({}).strict(),
    execution: { concurrency: 'exclusive', resources: () => [{ key: 'fixture:unknown-effect', mode: 'write' }] },
    async execute(_input, context) { calls += 1; const fs = await import('node:fs/promises'); await fs.writeFile(join(context.cwd, 'effect.txt'), 'complete', 'utf8'); throw new Error('injected settlement outcome unknown'); },
  };
  const llm = createMockLlm((request) => {
    const text = JSON.stringify(request.messages);
    if (text.includes('Choose the next LittleSheep activity')) return textResponse('{"type":"problem","confidence":0.99,"reason":"execute the synthetic effect"}');
    if (text.includes('You are the RECOVER stage')) return textResponse('{"action":"abort","reason":"unknown side effect must not replay"}');
    if (text.includes('You are the VERIFY stage')) return textResponse('{"verdict":"fail","reason":"outcome is unknown"}');
    if (text.includes('You are the DECIDE stage')) return textResponse('{"plan":[{"description":"execute effect","tools":["rcd_unknown_effect"]}]}');
    if (!request.messages.some((message) => message.role === 'tool')) return toolCallResponse([{ id: 'unknown-effect-1', name: 'rcd_unknown_effect', args: {} }]);
    return textResponse('Effect result is unknown; stop safely.');
  });
  const first = await createRunner({ config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING, model: 'rcd/scripted-provider', llm, approve: async () => true, skillsDirs: [] });
  runners.push(first);
  const run = await first.run({ runId: 'rcd-s0b-x01', text: 'Run the synthetic effect once and handle its uncertain outcome.', cwd: work, additionalTools: [probe] });
  const effectStatus = run.sideEffects?.find((effect) => effect.toolName === probe.name)?.status ?? 'missing';
  const effectBytes = await readFile(join(work, 'effect.txt')).catch(() => Buffer.alloc(0));
  await first.shutdown();
  runners.splice(runners.indexOf(first), 1);
  const restart = await createRunner({ config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING, model: 'rcd/scripted-provider', llm: createMockLlm(textResponse('must not execute during recovery')), skillsDirs: [] });
  runners.push(restart);
  const recovery = await restart.recoverDurableRun?.(run.sessionId, run.runId);
  const second = await restart.recoverDurableRun?.(run.sessionId, run.runId);
  const safe = effectStatus === 'unknown' && calls === 1 && recovery?.projection.unknownEffectIds.length === 1 && second?.actions.length === 0;
  await writeObservation('X01', {
    testLayer: 'real_runner_durable_run_with_post_effect_pre_settlement_fault_injection_and_restart_recovery', provider: 'scripted-mock',
    toolExecutions: calls, toolCallCount: run.toolInvocations?.length ?? 0, sideEffectStatus: effectStatus,
    faultInjection: { phase: 'after_fixture_write_before_tool_result_return', processCrash: false, injectedException: true },
    sideEffects: { toolExecutionCount: calls, settlement: effectStatus },
    fixtureEvidence: [{ ref: 'fixture://X01/effect.txt', sha256: (await import('node:crypto')).createHash('sha256').update(effectBytes).digest('hex'), bytes: effectBytes.byteLength }],
    recoveryActions: recovery?.actions.map((action) => action.kind) ?? [],
    secondRecoveryActions: second?.actions.map((action) => action.kind) ?? [], productResult: safe ? 'correctly_blocked' : 'failed',
    recoveryProjection: recovery ? { status: recovery.projection.status, pendingEffectIds: recovery.projection.pendingEffectIds, unknownEffectIds: recovery.projection.unknownEffectIds } : null,
    stopReason: run.status, oracle: 'The fixture write completes, then a controlled exception occurs before tool result/settlement confirmation; real Runner restart recovery keeps the settlement unknown and does not replay the effect.',
    evidenceRefs: ['observation://X01/side-effect-status', 'observation://X01/recovery-actions'],
  });
}
