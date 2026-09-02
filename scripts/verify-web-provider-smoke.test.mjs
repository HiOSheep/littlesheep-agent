import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = fileURLToPath(new URL('./verify-web-provider-smoke.mjs', import.meta.url));
const fetchSmokeScriptPath = fileURLToPath(new URL('./verify-web-fetch-smoke.mjs', import.meta.url));

function runSmoke(args, env = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      LS_TAVILY_API_KEY: '',
      TAVILY_API_KEY: '',
      ...env,
    },
  });
}

describe('web provider smoke report boundary', () => {
  it('skips before a live request when no isolated key is available', () => {
    const result = runSmoke([]);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      check: 'setup', status: 'skipped', ok: false, isolated: true,
    });
    expect(result.stdout).not.toContain('Authorization');
    expect(result.stdout).not.toContain('Bearer');
  });

  it('accepts the explicit DoH mode without accepting a caller-supplied resolver endpoint', () => {
    const doh = runSmoke(['--dns-resolver=cloudflare_doh']);

    expect(doh.status, doh.stderr).toBe(0);
    expect(JSON.parse(doh.stdout)).toMatchObject({
      check: 'setup', status: 'skipped', ok: false, isolated: true,
    });

    const arbitraryEndpoint = runSmoke(['--dns-resolver=https://resolver.example/dns-query']);

    expect(arbitraryEndpoint.status, arbitraryEndpoint.stderr).toBe(1);
    expect(JSON.parse(arbitraryEndpoint.stdout)).toEqual({
      check: 'setup', status: 'failed', ok: false, errorKind: 'unexpected_failure',
    });
    expect(arbitraryEndpoint.stdout).not.toContain('resolver.example');
  });

  it('does not project raw setup errors or an inherited-looking key', () => {
    const fixtureKey = 'tvly-smoke-report-fixture-secret';
    const result = runSmoke(['--timeout-ms=not-a-number'], { LS_TAVILY_API_KEY: fixtureKey });

    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      check: 'setup', status: 'failed', ok: false, errorKind: 'unexpected_failure',
    });
    expect(result.stdout).not.toContain(fixtureKey);
    expect(result.stdout).not.toContain('timeout-ms');
  });

  it('rejects an unrelated fetch URL option without echoing it', () => {
    const fixture = 'https://fixture.example/?access_token=smoke-test-secret';
    const result = runSmoke([`--fetch-url=${fixture}`]);

    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      check: 'setup', status: 'failed', ok: false, errorKind: 'unexpected_failure',
    });
    expect(result.stdout).not.toContain(fixture);
    expect(result.stdout).not.toContain('smoke-test-secret');
  });

  it('keeps the live fetch report limited to origins and stable error kinds', async () => {
    const source = await readFile(scriptPath, 'utf8');

    expect(source).toContain('requestedOrigin: new URL(fetched.document.requestedUrl).origin');
    expect(source).toContain('finalOrigin: new URL(fetched.document.finalUrl).origin');
    expect(source).not.toContain('requestedUrl: fetched.document.requestedUrl');
    expect(source).not.toContain('errorMessage:');
    expect(source).toContain("stage = 'public-fetch-and-citation';");
    expect(source).toContain("stage = 'public-fetch-preflight';");
    expect(source).toContain("await validatePublicUrl('https://example.com/', { policy, resolveHost: preflightResolver });");
    expect(source).toContain("check: 'public-fetch-preflight', status: 'passed', ok: true, dnsResolver: args.dnsResolver, providerRequests: counters.providerRequests");
    expect(source).toContain("dns-resolver");
    expect(source.indexOf("stage = 'public-fetch-preflight';")).toBeLessThan(source.indexOf("stage = 'search';"));
    expect(source).toContain("runtime.fetch({ url: search.results[0].url, purpose: 'verification', citationId: search.results[0].citationId })");
    expect(source).not.toContain('fetchUrl');
    expect(source).toContain("status: smokeFailureStatus(errorKind)");
    expect(source).toContain('check: \'live-smoke\', stage,');
    expect(source).toContain("return /^web_[a-z0-9_]+$/u.test(kind) ? kind : 'unexpected_failure';");
    expect(source).toContain("return errorKind === 'web_ssrf_blocked' || errorKind === 'web_dns_check_failed'");
  });

  it('keeps the public fetch smoke report on the same bounded error contract', async () => {
    const source = await readFile(fetchSmokeScriptPath, 'utf8');

    expect(source).toContain('finalOrigin: new URL(document.finalUrl).origin');
    expect(source).not.toContain('finalUrl: document.finalUrl');
    expect(source).not.toContain('errorMessage:');
    expect(source).toContain('const errorKind = reportErrorKind(error);');
    expect(source).toContain('errorKind,');
    expect(source).toContain("return /^web_[a-z0-9_]+$/u.test(kind) ? kind : 'unexpected_failure';");
    expect(source).toContain("return errorKind === 'web_ssrf_blocked' || errorKind === 'web_dns_check_failed'");
    expect(source).toContain("? 'blocked'");
  });

  it('rejects an unsupported public-fetch smoke argument without echoing it', () => {
    const fixture = 'https://fixture.example/?access_token=smoke-test-secret';
    const result = spawnSync(process.execPath, [fetchSmokeScriptPath, `--target=${fixture}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      check: 'web-fetch-public-smoke', status: 'failed', ok: false, errorKind: 'unexpected_failure',
    });
    expect(result.stdout).not.toContain(fixture);
    expect(result.stdout).not.toContain('smoke-test-secret');
  });

  it('accepts pnpm forwarding syntax but still SSRF-blocks a loopback target before a request', () => {
    const result = spawnSync(process.execPath, [fetchSmokeScriptPath, '--', '--url=https://127.0.0.1:1/'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      check: 'web-fetch-public-smoke', status: 'blocked', ok: false, errorKind: 'web_ssrf_blocked',
    });
  });
});
