// @littlesheep/skills — use_skill.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillLoader } from './loader.js';
import { createUseSkillTool } from './use_skill.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ls-use-skill-'));
}

function writeSkill(base: string, name: string, fm: string, body: string): void {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${fm}\n---\n${body}`, 'utf8');
}

describe('createUseSkillTool', () => {
  it('loads a skill body on valid name', async () => {
    const base = makeTempDir();
    writeSkill(base, 'demo', 'name: demo\ndescription: Demo.', 'Demo body content.');
    const loader = await createSkillLoader({ dirs: [base] });
    const tool = createUseSkillTool(loader);

    const result = await tool.execute({ name: 'demo' }, {
      sessionId: 's' as never,
      runId: 'r',
      cwd: process.cwd(),
    } as never);

    expect(result.ok).toBe(true);
    expect(result.output).toBe('Demo body content.');
  });

  it('returns ok:false on unknown name', async () => {
    const base = makeTempDir();
    const loader = await createSkillLoader({ dirs: [base] });
    const tool = createUseSkillTool(loader);

    const result = await tool.execute({ name: 'nope' }, {
      sessionId: 's' as never,
      runId: 'r',
      cwd: process.cwd(),
    } as never);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('embeds available skill names in description', async () => {
    const base = makeTempDir();
    writeSkill(base, 'alpha', 'name: alpha\ndescription: Alpha.', 'a');
    writeSkill(base, 'beta', 'name: beta\ndescription: Beta.', 'b');
    const loader = await createSkillLoader({ dirs: [base] });
    const tool = createUseSkillTool(loader);

    expect(tool.description).toContain('alpha');
    expect(tool.description).toContain('beta');
  });

  it('has name "use_skill" and an input schema', () => {
    const emptyIndex = { skills: [], discovered: [], sources: [], disabled: [] };
    const loader = {
      index: emptyIndex,
      loadBody: async () => undefined,
      reload: async () => emptyIndex,
      replaceOwnedSources: async () => emptyIndex,
    };
    const tool = createUseSkillTool(loader);
    expect(tool.name).toBe('use_skill');
    expect(tool.inputSchema).toBeDefined();
  });
});
