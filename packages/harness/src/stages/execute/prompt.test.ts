// CE-01 / CE-03: the prompt's workspace and shell facts come from the run.
//
// The `# Workspace` section used to be rendered from
// `agents.defaults.workspace`, while the tool context resolved the directory
// from the request. Whenever the two differed — a project-bound session, an
// external directory, a workspace the user had just switched to — the model
// planned against one directory and its tools ran in another.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG, type Config } from '@littlesheep/config';
import { textMessage } from '@littlesheep/types';
import { describeExecutionShell } from '@littlesheep/tools';
import { makeCtx, makeTool } from '../../tests/helpers.js';
import { buildExecuteSystemPrompt } from './prompt.js';
import { renderCapabilitySnapshot } from '../../runtime-awareness.js';

const deps = {
  model: 'test-model',
  config: DEFAULT_CONFIG as Config,
  branding: DEFAULT_BRANDING,
} as const;

describe('the execute prompt workspace fact', () => {
  it('names the directory this run executes in, not the configured default', async () => {
    const ctx = makeCtx({ inbound: textMessage('user', 'make a game'), tools: [makeTool('read', { ok: true, output: '' })] });
    ctx.cwd = 'D:\\projects\\with space\\game';

    const bundle = await buildExecuteSystemPrompt(deps as never, ctx);

    expect(bundle.text).toContain('Working directory: `D:\\projects\\with space\\game`');
    // The configured default is a different directory in this fixture; naming it
    // instead is exactly the drift this guards against.
    expect(DEFAULT_CONFIG.agents.defaults.workspace).not.toBe(ctx.cwd);
    expect(bundle.text).not.toContain(`Working directory: \`${DEFAULT_CONFIG.agents.defaults.workspace}\``);
  });

  it('keeps the workspace fact above the cache boundary, byte-stable for the run', async () => {
    const ctx = makeCtx({ inbound: textMessage('user', 'hello'), tools: [makeTool('read', { ok: true, output: '' })] });
    ctx.cwd = '/tmp/run-workspace';

    const first = await buildExecuteSystemPrompt(deps as never, ctx);
    const second = await buildExecuteSystemPrompt(deps as never, ctx);

    expect(first.stableText).toBe(second.stableText);
    expect(first.stableText).toContain('Working directory: `/tmp/run-workspace`');
  });
});

describe('the disclosed execution shell', () => {
  it('matches the interpreter the exec tool actually starts', () => {
    const shell = describeExecutionShell();
    const facts = renderCapabilitySnapshot(makeCtx({}));

    expect(facts).toContain(`- shell: ${shell.binary} ${shell.args.join(' ')} "<command>"`);
    if (shell.family === 'windows-powershell') {
      // Named exactly, and explicitly not PowerShell 7, which is a different
      // executable. No version number is invented.
      expect(facts).toContain('Windows PowerShell, not PowerShell 7/pwsh');
      expect(facts).toContain('Test-Path');
      expect(facts).toContain('quote paths containing spaces');
      expect(facts).not.toContain('pwsh.exe');
    } else {
      expect(facts).toContain('POSIX sh, not bash');
    }
  });

  it('is disclosed even when the runtime TOOLS.md says nothing', () => {
    const ctx = makeCtx({ bootstrap: { 'TOOLS.md': '(placeholder)' } });

    expect(renderCapabilitySnapshot(ctx)).toContain('- shell: ');
  });
});
