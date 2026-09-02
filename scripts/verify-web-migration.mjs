import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigSchema, loadConfig, saveConfig } from '../packages/config/dist/index.js';
import { MemoryStore } from '../packages/memory-core/dist/index.js';
import { ExecutionLogStore } from '../packages/runner/dist/index.js';
import { RunCheckpointStore } from '../packages/runner/dist/index.js';
import { SearchProviderRegistry, WebRetrievalRuntime } from '../packages/web/dist/index.js';
import { asSessionId } from '../packages/types/dist/index.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Isolated migration/rollback rehearsal. It never reads or writes the active
 * application data root and uses a counting provider to prove that disabling
 * web retrieval prevents new network work after restart/replay.
 */
async function main() {
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-web-migration-'));
  const checks = [];
  const record = (name, ok, detail = undefined) => checks.push({ name, status: ok ? 'passed' : 'failed', ok, ...(detail ? { detail } : {}) });
  let providerRequests = 0;

  try {
    const legacyConfigPath = join(root, 'legacy-config.json');
    await saveConfig({
      ...ConfigSchema.parse({}),
      web: undefined,
    }, legacyConfigPath);
    const legacyRaw = JSON.parse(await readFile(legacyConfigPath, 'utf8'));
    delete legacyRaw.web;
    await writeFile(legacyConfigPath, JSON.stringify(legacyRaw), 'utf8');
    const loadedLegacy = await loadConfig({ configPath: legacyConfigPath });
    record('legacy-config-loads-with-web-disabled', loadedLegacy.web.enabled === false);

    const config = ConfigSchema.parse({
      ...loadedLegacy,
      web: {
        ...loadedLegacy.web,
        enabled: true,
        defaultProvider: 'counting',
        providers: [{ id: 'counting', type: 'test-counting', apiKeyRef: '$MIGRATION_KEY' }],
      },
    });
    await saveConfig(config, join(root, 'new-config.json'));
    const roundTripped = await loadConfig({ configPath: join(root, 'new-config.json') });
    record('new-config-round-trips-with-secret-reference-only',
      roundTripped.web.providers[0]?.apiKeyRef === '$MIGRATION_KEY' && !JSON.stringify(roundTripped).includes('migration-secret-value'));

    const memory = new MemoryStore({ rootDir: join(root, 'memory') });
    const memoryText = '# Preserved memory\n\n- Migration rehearsal marker\n';
    await memory.writeLongTerm(memoryText);
    const memoryBefore = await memory.readLongTerm();

    const webEvidence = {
      version: 1,
      providerId: 'counting',
      generatedAt: '2026-08-29T00:00:00.000Z',
      completeness: 'complete',
      citationIds: ['web-migration-citation'],
      citations: [{
        id: 'web-migration-citation',
        origin: 'https://example.com',
        url: 'https://example.com/article',
        urlHash: 'a'.repeat(64),
        title: 'Bounded migration evidence',
        fetchedAt: '2026-08-29T00:00:00.000Z',
        status: 'fetched',
        truncated: false,
      }],
      citationCount: 1,
      documentCount: 1,
      cached: false,
      partial: false,
      truncated: false,
      blocked: false,
      stale: false,
    };

    const executionLogs = new ExecutionLogStore({ rootDir: join(root, 'execution-logs') });
    const runId = 'migration-run';
    await executionLogs.write({
      runId,
      sessionId: 'migration-session',
      startedAt: '2026-08-29T00:00:00.000Z',
      endedAt: '2026-08-29T00:00:00.100Z',
      status: 'ok',
      model: 'test/model',
      inboundText: 'migration rehearsal',
      reply: 'completed',
      trace: [],
      messages: [],
      webEvidence,
      durationMs: 100,
    });

    const checkpoints = new RunCheckpointStore({ rootDir: join(root, 'checkpoints') });
    await checkpoints.initialize();
    const checkpointId = 'migration-checkpoint';
    await checkpoints.write({
      version: 1,
      id: checkpointId,
      runId,
      sessionId: asSessionId('migration-session'),
      status: 'recoverable',
      currentStage: 'execute',
      taskBookRevision: 1,
      eventCursor: 0,
      pendingEventIds: [],
      contextSnapshotIds: [],
      sideEffects: [],
      loopBudget: { attemptsUsed: 0, maxAttempts: 1, elapsedMs: 0, maxElapsedMs: 10_000, noProgressRounds: 0, maxNoProgressRounds: 1 },
      webEvidence,
      createdAt: '2026-08-29T00:00:00.000Z',
      reason: 'migration rehearsal',
    });

    const provider = {
      id: 'counting',
      displayName: 'Counting test provider',
      capabilities: { search: true, recency: false, domains: false, language: false, citations: true },
      async search() {
        providerRequests += 1;
        throw new Error('network must not be reached in disabled rehearsal');
      },
    };
    const registry = new SearchProviderRegistry([provider]);
    const disabledPolicy = {
      version: 1,
      enabled: false,
      providerId: 'counting',
      mode: 'disabled',
      allowDomains: [], blockDomains: [], strictReadApproval: false,
      maxResults: 2, maxQueryChars: 500, maxQueriesPerRun: 0, maxFetchesPerRun: 0,
      maxConcurrentRequests: 1, searchTimeoutMs: 2_000, fetchTimeoutMs: 2_000,
      totalTimeoutMs: 5_000, maxResponseBytes: 32 * 1024, maxExtractedChars: 2_000,
      maxRedirects: 0, cacheEnabled: false, cacheTtlSeconds: 0, cacheMaxBytes: 0,
      browserFallback: 'disabled', sensitiveQueryPolicy: 'deny',
    };
    const disabledRuntime = new WebRetrievalRuntime({ runId: 'migration-disabled-1', policy: disabledPolicy, providers: registry });
    try {
      await disabledRuntime.search({ query: 'must remain disabled', maxResults: 1, runId: 'ignored' });
      record('disabled-runtime-fails-closed', false);
    } catch (error) {
      record('disabled-runtime-fails-closed', error?.kind === 'web_disabled');
    } finally {
      disabledRuntime.dispose();
    }
    const restartedRuntime = new WebRetrievalRuntime({ runId: 'migration-disabled-2', policy: disabledPolicy, providers: registry });
    try {
      await restartedRuntime.search({ query: 'replay must not search', maxResults: 1, runId: 'ignored' });
    } catch (error) {
      record('restart-remains-disabled', error?.kind === 'web_disabled');
    } finally {
      restartedRuntime.dispose();
    }
    record('disabled-network-zero-provider-requests', providerRequests === 0, { providerRequests });

    const readLog = await executionLogs.read(runId);
    const readCheckpoint = await checkpoints.read(checkpointId);
    const memoryAfter = await memory.readLongTerm();
    record('historical-execution-log-remains-readable', readLog?.webEvidence?.citationIds.includes('web-migration-citation') === true);
    record('historical-checkpoint-remains-readable', readCheckpoint?.webEvidence?.citationIds.includes('web-migration-citation') === true);
    record('memory-remains-unchanged', memoryAfter === memoryBefore);
    await memory.appendDaily('2026-08-29', 'ordinary memory write remains available after web disable');
    record('ordinary-local-memory-path-remains-available', (await memory.readDaily('2026-08-29')).includes('ordinary memory write'));

    checkpoints.dispose();
    const failed = checks.filter((check) => !check.ok);
    print({ check: 'web-migration-rollback', status: failed.length === 0 ? 'passed' : 'failed', ok: failed.length === 0, checks });
    return failed.length === 0 ? 0 : 1;
  } catch (error) {
    print({ check: 'web-migration-rollback', status: 'failed', ok: false, errorKind: error?.name || 'Error', errorMessage: safeMessage(error), providerRequests });
    return 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function safeMessage(error) {
  return String(error?.message ?? error).replace(/(?:Bearer|api[_-]?key|authorization)\s*[:=]?\s*[^\s,;]+/giu, '[redacted]').slice(0, 300);
}

function print(value) { console.log(JSON.stringify(value)); }

main().then((code) => { process.exitCode = code; }).catch((error) => {
  print({ check: 'web-migration-rollback', status: 'failed', ok: false, errorKind: error?.name || 'Error', errorMessage: safeMessage(error) });
  process.exitCode = 1;
});
