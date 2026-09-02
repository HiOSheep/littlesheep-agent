import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(new URL('./verify-web-llm-evidence.mjs', import.meta.url));

describe('web LLM evidence verifier report boundary', () => {
  it('emits only a stable error kind when the real LLM verifier fails', async () => {
    const source = await readFile(scriptPath, 'utf8');

    expect(source).toContain("errorKind: reportErrorKind(error)");
    expect(source).toContain("return /^web_[a-z0-9_]+$/u.test(kind) ? kind : 'unexpected_failure';");
    expect(source).not.toContain('errorMessage:');
    expect(source).not.toContain("String(error?.message ?? error)");
  });
});
