import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(new URL('./verify-web-live-llm-evidence.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe('live Web evidence LLM verifier boundary', () => {
  it('keeps live keys process-scoped and output content-free', async () => {
    const source = await readFile(scriptPath, 'utf8');
    expect(source).toContain("process.env.LS_TAVILY_API_KEY?.trim() || process.env.TAVILY_API_KEY?.trim()");
    expect(source).toContain("process.env.LS_DEEPSEEK_API_KEY?.trim() || process.env.DEEPSEEK_API_KEY?.trim()");
    expect(source).toContain("fetchedContentHash: fetched.contentHash");
    expect(source).not.toContain('fetchedUrl:');
    expect(source).not.toContain('reply: reply');
    expect(source).toContain('externalUntrusted: fetched.externalUntrusted');
    const outputStart = source.indexOf("print({\n      check: 'web-live-llm-evidence'");
    expect(outputStart).toBeGreaterThanOrEqual(0);
    const outputEnd = source.indexOf('return 0;', outputStart);
    expect(source.slice(outputStart, outputEnd)).not.toContain('query');
  });

  it('fails closed on arbitrary resolver and keeps stable error output', async () => {
    const source = await readFile(scriptPath, 'utf8');
    expect(source).toContain("dnsResolver !== 'system' && dnsResolver !== 'cloudflare_doh'");
    expect(source).toContain('errorKind: reportErrorKind(error)');
    expect(source).not.toContain('errorMessage:');
    expect(source).not.toContain("String(error?.message ?? error)");
  });

  it('accepts pnpm forwarding after fixed package-script arguments', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--require-live', '--', '--dns-resolver=cloudflare_doh'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, LS_TAVILY_API_KEY: '', TAVILY_API_KEY: '', LS_DEEPSEEK_API_KEY: '', DEEPSEEK_API_KEY: '' },
    });

    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      check: 'web-live-llm-evidence', status: 'skipped', ok: false, isolated: true,
    });
    expect(result.stdout).not.toContain('dns-resolver');
  });
});
