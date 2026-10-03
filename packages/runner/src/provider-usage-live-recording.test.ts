// New HTTP calls through the shipped client, Harness and durable store. No old
// logs or hand-written durable events are used to produce the usage facts.
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { OpenAIClient } from '@littlesheep/llm';
import { createRunner, type AgentRunner } from './runner.js';
import { ProviderUsageDailyService } from './provider-usage-daily-service.js';
import { DurableEventStore } from './durable-event-store.js';

let root: string;
let runner: AgentRunner | undefined;
let server: Server | undefined;
afterEach(async () => {
  await runner?.shutdown();
  runner = undefined;
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  server = undefined;
  delete process.env.LITTLESHEEP_DATA_DIR;
  if (root) await rm(root, { recursive: true, force: true });
});

type Scenario = 'normal' | 'retry' | 'tool' | 'missing' | 'failed' | 'invalid';
async function fixture(scenario: Scenario) {
  root = await mkdtemp(join(tmpdir(), 'ls-live-usage-'));
  const workspace = join(root, 'workplace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'sample.txt'), 'local fixture data');
  process.env.LITTLESHEEP_DATA_DIR = root;
  let calls = 0;
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls += 1;
    if (scenario === 'failed') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture unauthorized' } }));
      return;
    }
    const usage = scenario === 'missing' ? { prompt_tokens: 12 } : { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
    const tool = scenario === 'tool' && calls === 1;
    const truncated = scenario === 'retry' && calls === 1;
    const content = scenario === 'invalid' ? '<｜DSML｜ calls><｜DSML｜ invoke name="unknown">' : tool ? null : 'Fixture response';
    const toolCalls = tool ? [{ id: 'fixture-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ file_path: join(workspace, 'sample.txt') }) } }] : undefined;
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = tool ? { tool_calls: toolCalls!.map((call, index) => ({ ...call, index })) } : { content };
      res.write(`data: ${JSON.stringify({ model: 'fixture', choices: [{ index: 0, delta, ...(truncated ? {} : { finish_reason: tool ? 'tool_calls' : 'stop' }) }] })}\n\n`);
      // EOF with no newline exercises the actual decoder, including usage-only chunks.
      res.end(`data: ${JSON.stringify({ model: 'fixture', choices: [], usage })}`);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'fixture', choices: truncated ? [] : [{ index: 0, message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const config = structuredClone(DEFAULT_CONFIG);
  config.agents.defaults.workspace = workspace;
  runner = await createRunner({ config, branding: DEFAULT_BRANDING, model: 'fixture/model',
    llm: new OpenAIClient({ baseURL: `http://127.0.0.1:${address.port}`, retry: { maxAttempts: 2, baseDelayMs: 1, jitter: false } }),
    skillsDirs: [], containerRoot: root });
  const store = runner.infra.durableEventStore;
  const historicalListing = vi.spyOn(store, 'listRunPartitions');
  const service = new ProviderUsageDailyService({ dataRoot: root, eventSource: store });
  const query = async () => {
    await service.synchronizeCurrent();
    const today = new Date().toISOString().slice(0, 10);
    return service.query({ from: today, to: today, timezone: 'UTC', timezoneSource: 'request' });
  };
  return { query, service, store, historicalListing, calls: () => calls };
}

describe('live usage recording for new calls', () => {
  it.each(['normal', 'retry', 'tool'] as const)('records %s calls without manual refresh or a history scan', async scenario => {
    const f = await fixture(scenario);
    const result = await runner!.run({ text: scenario === 'tool' ? '读取工作区中的 sample.txt' : 'hello' });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    const series = await f.query();
    expect(f.calls()).toBe(scenario === 'normal' ? 1 : 2);
    expect(series.totals).toMatchObject({ requests: f.calls(), total: 15 * f.calls(), input: 12 * f.calls(), output: 3 * f.calls() });
    expect(series.days[0]).toMatchObject({ state: 'recorded', missingResponses: 0, unreportedRequests: 0 });
    expect(f.historicalListing).not.toHaveBeenCalled();
    const events = await f.store.read(String(result.sessionId), result.runId);
    expect(events.filter(event => event.type === 'provider_usage_recorded')).toHaveLength(f.calls());
    expect(events.filter(event => event.type === 'model_response_received').length).toBeGreaterThan(0);
    const receipt = events.findIndex(event => event.type === 'provider_usage_recorded');
    const response = events.findIndex(event => event.type === 'model_response_received');
    expect(receipt).toBeLessThan(response);
    // Both projections exist; they must not count the same response twice.
    expect((await f.query()).totals.total).toBe(series.totals.total);
    const restarted = new ProviderUsageDailyService({ dataRoot: root, eventSource: f.store });
    await restarted.initialize();
    expect(restarted.indexStore.runs.flatMap(run => run.attempts)).toHaveLength(f.calls());
  });

  it('keeps already reported usage when semantic response validation fails', async () => {
    const f = await fixture('invalid');
    await runner!.run({ text: 'hello' });
    const series = await f.query();
    expect(f.calls()).toBeGreaterThan(0);
    expect(series.totals.total).toBe(f.calls() * 15);
    expect(series.days[0]?.state).toBe('recorded');
  });

  it('reports missing Provider counters as a recording error, never a complete zero', async () => {
    const f = await fixture('missing');
    expect((await runner!.run({ text: 'hello' })).status).toBe('ok');
    const series = await f.query();
    expect(series.days[0]).toMatchObject({ state: 'recording_error', requests: 0, missingResponses: f.calls() });
    expect(series.coverage.missingResponses).toBeGreaterThan(0);
  });

  it('keeps rejected calls separate from recording errors and billed counts', async () => {
    const f = await fixture('failed');
    await runner!.run({ text: 'hello' });
    const series = await f.query();
    expect(series.totals.requests).toBe(0);
    expect(series.days[0]).toMatchObject({ state: 'empty', failedRequests: f.calls(), missingResponses: 0, unreportedRequests: 0 });
  });

  it('recovers a new call after restart even if the usage page was never opened', async () => {
    const f = await fixture('normal');
    await runner!.run({ text: 'hello' });
    // No query, refresh or backfill occurred before the new store was created.
    const store = new DurableEventStore({ rootDir: join(root, 'durable-events') });
    const listing = vi.spyOn(store, 'listRunPartitions');
    expect(await store.listChangedRunPartitions()).toHaveLength(1);
    const service = new ProviderUsageDailyService({ dataRoot: root, eventSource: store });
    await service.synchronizeCurrent();
    expect(service.indexStore.runs.flatMap(run => run.attempts)).toHaveLength(1);
    expect(await store.listChangedRunPartitions()).toHaveLength(0);
    expect(listing).not.toHaveBeenCalled();
    expect(f.calls()).toBe(1);
  });

  it('retains pending receipts after index write failure and retries without rebilling', async () => {
    const f = await fixture('normal');
    await runner!.run({ text: 'hello' });
    await mkdir(f.service.indexStore.indexFile, { recursive: true });
    const first = await f.query();
    expect(first.coverage.stale).toBe(true);
    expect(await f.store.listChangedRunPartitions()).toHaveLength(1);
    await rm(f.service.indexStore.indexFile, { recursive: true });
    const second = await f.query();
    expect(second.coverage.stale).toBe(false);
    expect(second.totals.total).toBe(15);
    expect(await f.store.listChangedRunPartitions()).toHaveLength(0);
    expect(f.calls()).toBe(1);
  });
});
