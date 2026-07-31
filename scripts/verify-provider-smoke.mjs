import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBranding, resolveDataDir } from '../packages/branding/dist/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supportedChecks = new Set(['chat', 'continuity', 'tool', 'abort']);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const branding = await loadBranding(join(repoRoot, 'branding.config.json'));
  const dataDir = resolveDataDir(branding);
  const locatorPath = join(dataDir, 'runtime', 'local-app-api.json');
  const locator = await readLocator(locatorPath);
  const controller = new AbortController();
  const overallTimeout = setTimeout(
    () => controller.abort(),
    Math.max(15_000, (args.timeoutSeconds * args.checks.length + 10) * 1_000),
  );

  try {
    const response = await fetch(
      `http://${locator.host}:${locator.port}/runtime/provider-calibration`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${locator.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: args.provider,
          model: args.model,
          reasoning: args.reasoning,
          checks: args.checks,
          timeoutSeconds: args.timeoutSeconds,
        }),
        signal: controller.signal,
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Running LittleSheep rejected Provider calibration (${response.status}): ${safeMessage(payload.error)}`);
    }
    for (const result of payload.results ?? []) console.log(JSON.stringify(result));
    console.log(JSON.stringify({
      check: 'summary',
      ok: payload.ok === true,
      source: 'running-main-process',
      provider: payload.provider,
      model: payload.model,
      checks: payload.checks,
    }));
    return payload.ok === true ? 0 : 1;
  } finally {
    clearTimeout(overallTimeout);
  }
}

async function readLocator(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('LittleSheep is not running with a Provider calibration locator. Build and start the desktop app first.');
    }
    throw new Error(`Unable to read the LittleSheep runtime locator: ${errorName(error)}`);
  }
  if (
    parsed?.version !== 1
    || parsed.host !== '127.0.0.1'
    || !Number.isInteger(parsed.port)
    || parsed.port < 1
    || parsed.port > 65_535
    || typeof parsed.token !== 'string'
    || parsed.token.length < 32
  ) {
    throw new Error('LittleSheep runtime locator is invalid or stale. Restart the desktop app.');
  }
  return parsed;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--') continue;
    if (!current?.startsWith('--')) continue;
    const equals = current.indexOf('=');
    if (equals > 2) {
      values.set(current.slice(2, equals), current.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      values.set(current.slice(2), next);
      index += 1;
    } else {
      values.set(current.slice(2), 'true');
    }
  }

  const checks = (values.get('checks') ?? 'chat,continuity,tool,abort')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (checks.length === 0) throw new Error('At least one Provider check is required.');
  for (const check of checks) {
    if (!supportedChecks.has(check)) throw new Error(`Unknown Provider check: ${check}`);
  }

  const reasoning = values.get('reasoning') ?? 'high';
  if (!['auto', 'low', 'medium', 'high', 'ultra'].includes(reasoning)) {
    throw new Error(`Unknown reasoning level: ${reasoning}`);
  }
  const timeoutSeconds = Number(values.get('timeout-seconds') ?? 45);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 300) {
    throw new Error('timeout-seconds must be between 5 and 300.');
  }

  return {
    provider: values.get('provider') ?? 'deepseek',
    model: values.get('model'),
    reasoning,
    checks,
    timeoutSeconds,
  };
}

function safeMessage(value) {
  return typeof value === 'string' ? value.slice(0, 300) : 'unknown error';
}

function errorName(error) {
  return error instanceof Error ? error.name || 'Error' : typeof error;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(JSON.stringify({
      check: 'setup',
      ok: false,
      source: 'running-main-process',
      errorKind: errorName(error),
      errorMessage: safeMessage(error instanceof Error ? error.message : error),
    }));
    process.exitCode = 1;
  });
