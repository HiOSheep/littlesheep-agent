// R4-B3: trial identity/isolation, write-once records, interrupted writes and
// provider budget enforcement (including concurrent calls, retries, failure
// requests, token clamping and unavailable usage). Offline: the Provider is a
// local fake HTTP server; no real request leaves the machine.
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createBatchBudget, createBudgetEnvelope } from '../scripts/lib/r4b/budget.mjs';
import { gitProductState } from '../scripts/lib/r4b/contract.mjs';
import { readRecords, writeRecordAtomic } from '../scripts/lib/r4b/ledger.mjs';
import { buildRecord } from '../scripts/lib/r4b/record.mjs';
import { loadTaskSuite, taskById } from '../scripts/lib/r4b/tasks.mjs';
import { createTrial, recordFileName } from '../scripts/lib/r4b/trials.mjs';
import { createS3bMeasuredProvider } from './s3b-provider-metering.js';
import { resolveS3bProviderProfile } from '../scripts/lib/s3b-provider-config.mjs';

const loaded = loadTaskSuite();
const file02g = taskById(loaded, 'FILE-02-G');

const tempRoots = [];
async function tempDir(prefix = 'ls-v2-b3-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterAll(async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
});

function fakeObservation() {
  return {
    schemaVersion: 2,
    taskId: 'FILE-02-G',
    taskVersion: '2.0.0',
    observation: {
      dimensions: {
        goal: { status: 'passed', evidenceRefs: ['workspace://inventory-summary.json#sha256=abc'], rejectionReasons: [], missingFields: [] },
        contract: { status: 'not_applicable', evidenceRefs: [], rejectionReasons: [], missingFields: [] },
        mechanism: { status: 'not_exercised', triggered: false, evidenceRefs: [], rejectionReasons: [], missingFields: [] },
      },
      files: ['inventory-summary.json', 'inventory.csv'],
      successfulExecutions: 0,
      duplicateSuccessfulEffects: 0,
      modelConfig: { providerId: 'scripted', simulated: true, wireModelId: null, apiProtocol: null, parameters: {} },
      runtime: {
        infrastructureStatus: 'executed',
        startedAt: '2026-10-21T12:00:00.000Z',
        endedAt: '2026-10-21T12:00:01.000Z',
        durationMs: 1000,
        modelRequests: 3,
        toolProposals: 2,
        toolExecutions: 2,
        deniedToolCalls: 0,
        failedToolCalls: 0,
        settledEffects: 1,
      },
      safety: { networkPolicy: 'denied', agentNetworkRequests: 0, forbiddenRequests: 0, credentialsRedacted: true },
      cleanup: { attempted: true, succeeded: true, residuals: [] },
    },
  };
}

function recordFor({ trial = 1, batchId = 'r4b-offline-2026-10-21' } = {}) {
  return buildRecord({
    loaded,
    task: file02g,
    trial,
    batchId,
    observation: fakeObservation(),
    gitState: { sha: 'c12fb52e031d70c29f5781a4ea843ba474b2df6a', treeFingerprint: 'tree', dirty: false, sourceDirty: false, dirtyPaths: [] },
    evaluatorFingerprint: 'a'.repeat(64),
    contractSha256: 'b'.repeat(64),
    taskSuiteSha256: loaded.suiteSha256,
    command: `node scripts/eval-v2.mjs --run-controlled --task=FILE-02-G --trial=${trial}`,
  });
}

describe('trial identity and isolation', () => {
  it('creates distinct workspace roots for trials 1 and 5 and refuses 0/6', () => {
    const first = createTrial({ taskId: 'FILE-02-G', trial: 1 });
    const fifth = createTrial({ taskId: 'FILE-02-G', trial: 5 });
    tempRoots.push(first.root, fifth.root);
    expect(first.root).not.toBe(fifth.root);
    expect(first.workspaceDir).not.toBe(fifth.workspaceDir);
    expect(first.recordId).toBe('v2:r4b-offline-2026-10-21:FILE-02-G:trial:1');
    expect(first.fileName).toBe('v2__r4b-offline-2026-10-21__FILE-02-G__trial__1.json');
    expect(recordFileName(first.recordId)).not.toContain(':');
    expect(() => createTrial({ taskId: 'FILE-02-G', trial: 0 })).toThrow(/trial-number/);
    expect(() => createTrial({ taskId: 'FILE-02-G', trial: 6 })).toThrow(/trial-number/);
  });

  it('rejects unknown batch ids and task ids', () => {
    expect(() => createTrial({ taskId: 'FILE-02-G', trial: 1, batchId: 'BAD BATCH' })).toThrow(/trial-batch/);
    expect(() => createTrial({ taskId: 'file-02-g', trial: 1 })).toThrow(/trial-task/);
  });
});

describe('write-once records', () => {
  it('writes one valid record, refuses overwrite and reads it back', async () => {
    const dir = await tempDir();
    const record = recordFor();
    const written = writeRecordAtomic({ dir, record, task: file02g });
    expect(existsSync(written.path)).toBe(true);
    expect(JSON.parse(readFileSync(written.path, 'utf8')).recordId).toBe(record.recordId);
    expect(() => writeRecordAtomic({ dir, record, task: file02g })).toThrow(/LEDGER_RECORD_EXISTS/);
    const records = readRecords({ dir, tasks: loaded.tasks });
    expect(records).toHaveLength(1);
    expect(records[0].trial).toBe(1);
  });

  it('keeps trials 1 and 4 in independent files, without overwriting history', async () => {
    const dir = await tempDir();
    const trial1 = writeRecordAtomic({ dir, record: recordFor({ trial: 1 }), task: file02g });
    const trial4 = writeRecordAtomic({ dir, record: recordFor({ trial: 4 }), task: file02g });
    expect(trial1.path).not.toBe(trial4.path);
    expect((await readdir(dir)).filter((name) => name.endsWith('.json'))).toHaveLength(2);
  });

  it('an interrupted write leaves no partial record and removes its temp file', async () => {
    const dir = await tempDir();
    const record = recordFor();
    const failingIo = {
      exists: () => false,
      mkdir: () => undefined,
      writeFile: (path, data) => writeFileSync(path, data, 'utf8'),
      rename: () => { throw new Error('simulated interruption'); },
      remove: (path) => rmSync(path, { force: true }),
    };
    await expect(async () => writeRecordAtomic({ dir, record, task: file02g, io: failingIo }))
      .rejects.toMatchObject({ code: 'LEDGER_RECORD_WRITE_FAILED' });
    const files = (await readdir(dir)).filter((name) => name.includes('tmp-'));
    expect(files).toHaveLength(0);
    expect(existsSync(join(dir, recordFileName(record.recordId)))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Budget enforcement against a local fake Provider.
// ---------------------------------------------------------------------------

let server;
let serverUrl;
let hits = 0;
let scenario = 'success';
const providerCalls = [];

async function startProvider() {
  if (server) return;
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    providerCalls.push({ url: request.url, body: Buffer.concat(chunks).toString('utf8') });
    hits += 1;
    const mode = scenario;
    if (mode === 'retry-then-success' && hits === 1) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'server_error', message: 'fixture 500' } }));
      return;
    }
    if (mode === 'bad-request') {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'invalid_request', param: 'model', message: 'fixture 400' } }));
      return;
    }
    const usage = mode === 'no-usage' ? undefined : { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'chatcmpl-fixture',
      object: 'chat.completion',
      created: 1,
      model: 'fixture-model-v1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      ...(usage ? { usage } : {}),
    }));
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  serverUrl = `http://127.0.0.1:${address.port}/v1`;
}

afterAll(async () => {
  if (server) await new Promise((resolvePromise) => server.close(resolvePromise));
});

function providerProfile(overrides = {}) {
  return resolveS3bProviderProfile({
    S3B_PROVIDER_ID: 'fixture-provider',
    S3B_MODEL: 'fixture-model-v1',
    S3B_API_PROTOCOL: 'openai-chat-completions',
    S3B_BASE_URL: serverUrl,
    S3B_API_KEY: 'never-serialize-this-secret',
    S3B_MAX_PHYSICAL_REQUESTS: '2',
    S3B_MAX_OUTPUT_TOKENS: '256',
    S3B_MAX_COST_USD: '1.25',
    S3B_PROVIDER_BILLING_CAP_CONFIRMED: 'true',
    S3B_PROVIDER_BILLING_CAP_BASIS: 'fixture_hard_cap',
    ...overrides,
  });
}

function guardedProvider(envelope, profile, fetchImpl) {
  let sawSecret = false;
  const guardedFetch = async (resource, init) => {
    const charge = envelope.chargePhysical('attempt');
    if (!charge.allowed) throw new Error('V2 batch budget exhausted before dispatch');
    const response = await fetchImpl(resource, { ...init, redirect: 'error' });
    sawSecret = sawSecret || String(init?.headers?.Authorization ?? '').includes('never-serialize');
    return response;
  };
  const measured = createS3bMeasuredProvider({ profile, fetchImpl: guardedFetch });
  return { measured, sawSecret: () => sawSecret };
}

function chatRequest() {
  return {
    model: 'fixture-model-v1',
    messages: [{ role: 'user', content: 'budget fixture' }],
    max_tokens: 4096,
  };
}

describe('provider budget envelope', () => {
  it('concurrent requests cannot bypass the physical request budget', async () => {
    await startProvider();
    scenario = 'success';
    hits = 0;
    const envelope = createBudgetEnvelope({ physicalRequestBudget: 1, outputTokenBudget: 256 });
    const profile = providerProfile();
    const { measured } = guardedProvider(envelope, profile, fetch);
    const results = await Promise.allSettled([measured.client.chat(chatRequest()), measured.client.chat(chatRequest())]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(hits).toBe(1);
    expect(envelope.snapshot().physicalRequests).toBe(1);
    expect(envelope.snapshot().blockedRequests).toBe(1);
    expect(envelope.snapshot().exhausted).toBe(true);
  });

  it('counts retried and failed physical requests and clamps output tokens', async () => {
    await startProvider();
    scenario = 'retry-then-success';
    hits = 0;
    const envelope = createBudgetEnvelope({ physicalRequestBudget: 5, outputTokenBudget: 100 });
    const profile = providerProfile({ S3B_MAX_ATTEMPTS: '2' });
    const { measured } = guardedProvider(envelope, profile, fetch);
    const response = await measured.client.chat(chatRequest());
    expect(response.content).toBe('ok');
    expect(hits).toBe(2);
    expect(envelope.snapshot().physicalRequests).toBe(2);
    expect(envelope.snapshot().retries).toBe(0);
    const snapshot = measured.snapshot();
    expect(snapshot.physicalProviderRequests).toBe(2);
    expect(snapshot.usage.status).toBe('available');
    expect(snapshot.observedParameters[0].maxOutputTokens).toBe(256);
    expect(envelope.reserveOutputTokens(4096)).toBe(100);
    expect(envelope.snapshot().outputTokens.requested).toBe(4096);
    expect(envelope.snapshot().outputTokens.effective).toBe(100);
    envelope.recordObservedUsage({ inputTokens: snapshot.usage.inputTokens, outputTokens: snapshot.usage.outputTokens });
    expect(envelope.snapshot().outputTokens.status).toBe('available');
  });

  it('detects a deterministic 4xx without retrying and keeps usage unavailable', async () => {
    await startProvider();
    scenario = 'bad-request';
    hits = 0;
    const envelope = createBudgetEnvelope({ physicalRequestBudget: 5 });
    const profile = providerProfile();
    const { measured } = guardedProvider(envelope, profile, fetch);
    await expect(measured.client.chat(chatRequest())).rejects.toBeTruthy();
    expect(hits).toBe(1);
    expect(envelope.snapshot().physicalRequests).toBe(1);
    expect(measured.snapshot().nonRetryableResponses).toBe(1);
    expect(measured.snapshot().usage.status).toBe('unavailable');
    expect(envelope.snapshot().outputTokens.observedInput).toBeNull();
    expect(envelope.snapshot().outputTokens.observedOutput).toBeNull();
  });

  it('keeps missing usage unavailable and never infers zero', async () => {
    await startProvider();
    scenario = 'no-usage';
    hits = 0;
    const envelope = createBudgetEnvelope({ physicalRequestBudget: 5 });
    const profile = providerProfile();
    const { measured } = guardedProvider(envelope, profile, fetch);
    await measured.client.chat(chatRequest());
    const snapshot = measured.snapshot();
    expect(snapshot.usage.status).toBe('unavailable');
    expect(snapshot.usage.inputTokens).toBeNull();
    expect(envelope.snapshot().outputTokens.status).toBe('unavailable');
    expect(envelope.snapshot().outputTokens.observedInput).toBeNull();
  });

  it('shares one batch budget across trials and refuses over-budget charges', () => {
    const batch = createBatchBudget({ maxPhysicalRequests: 3, maxOutputTokens: 100 });
    expect(batch.chargePhysical().allowed).toBe(true);
    expect(batch.chargePhysical().allowed).toBe(true);
    expect(batch.chargePhysical().allowed).toBe(true);
    expect(batch.chargePhysical().allowed).toBe(false);
    expect(batch.chargeOutputTokens(60).allowed).toBe(true);
    expect(batch.chargeOutputTokens(60).allowed).toBe(false);
    expect(batch.snapshot().blockedRequests).toBe(2);
  });

  it('reads the repository git state without claiming a clean tree', () => {
    const state = gitProductState();
    expect(state.sha).toMatch(/^[0-9a-f]{40}$/u);
    expect(Array.isArray(state.dirtyPaths)).toBe(true);
  });
});
