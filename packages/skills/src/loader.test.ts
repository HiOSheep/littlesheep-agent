// @littlesheep/skills — loader.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSkillFile,
  loadSkillIndex,
  loadSkillBody,
  findBuiltinSkillsDir,
} from './loader.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ls-skills-'));
}

function writeSkill(base: string, name: string, frontmatter: string, body: string): void {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`, 'utf8');
}

// ─── parseSkillFile ──────────────────────────────────────────────────────

describe('parseSkillFile', () => {
  it('parses valid frontmatter + body', () => {
    const raw = '---\nname: example\ndescription: An example.\n---\n# Body\nInstructions.';
    const parsed = parseSkillFile(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.name).toBe('example');
    expect(parsed!.frontmatter.description).toBe('An example.');
    expect(parsed!.body).toBe('# Body\nInstructions.');
  });

  it('returns null when no frontmatter present', () => {
    expect(parseSkillFile('# Just markdown\nNo frontmatter.')).toBeNull();
  });

  it('handles CRLF line endings', () => {
    const raw = '---\r\nname: win\rd\ndescription: CRLF skill\r\n---\r\nBody text.';
    const parsed = parseSkillFile(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.name).toBe('win\rd');
    expect(parsed!.body).toBe('Body text.');
  });

  it('handles values containing colons (split on first colon only)', () => {
    const raw = '---\nname: foo\ndescription: A: B: C\n---\nbody';
    const parsed = parseSkillFile(raw);
    expect(parsed!.frontmatter.description).toBe('A: B: C');
  });

  it('returns null when frontmatter is not closed', () => {
    const raw = '---\nname: unclosed\ndescription: missing close';
    expect(parseSkillFile(raw)).toBeNull();
  });

  it('handles BOM prefix', () => {
    const raw = '\uFEFF---\nname: bom\ndescription: has bom\n---\nbody';
    const parsed = parseSkillFile(raw);
    expect(parsed!.frontmatter.name).toBe('bom');
  });
});

// ─── loadSkillIndex ──────────────────────────────────────────────────────

describe('loadSkillIndex', () => {
  it('loads multiple valid skills', async () => {
    const base = makeTempDir();
    writeSkill(base, 'alpha', 'name: alpha\ndescription: Alpha skill.', 'Alpha body.');
    writeSkill(base, 'beta', 'name: beta\ndescription: Beta skill.', 'Beta body.');
    const index = await loadSkillIndex({ dirs: [base] });
    expect(index.skills).toHaveLength(2);
    expect(index.skills.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('skips entries without SKILL.md', async () => {
    const base = makeTempDir();
    mkdirSync(join(base, 'no-skill-file'), { recursive: true });
    writeSkill(base, 'real', 'name: real\ndescription: Real.', 'body');
    const index = await loadSkillIndex({ dirs: [base] });
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0]!.name).toBe('real');
  });

  it('skips disabled skill names', async () => {
    const base = makeTempDir();
    writeSkill(base, 'keep', 'name: keep\ndescription: Keep.', 'body');
    writeSkill(base, 'skip', 'name: skip\ndescription: Skip.', 'body');
    const index = await loadSkillIndex({ dirs: [base], disabled: ['skip'] });
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0]!.name).toBe('keep');
    expect(index.disabled).toEqual(['skip']);
  });

  it('dedupes by name (first directory wins)', async () => {
    const dir1 = makeTempDir();
    const dir2 = makeTempDir();
    writeSkill(dir1, 'a', 'name: dup\ndescription: First.', 'first body');
    writeSkill(dir2, 'a', 'name: dup\ndescription: Second.', 'second body');
    const index = await loadSkillIndex({ dirs: [dir1, dir2] });
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0]!.description).toBe('First.');
  });

  it('skips invalid frontmatter', async () => {
    const base = makeTempDir();
    const dir = join(base, 'bad');
    mkdirSync(dir, { recursive: true });
    // Missing required `description`
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: bad\n---\nbody', 'utf8');
    const index = await loadSkillIndex({ dirs: [base] });
    expect(index.skills).toHaveLength(0);
  });

  it('skips non-existent dirs silently', async () => {
    const index = await loadSkillIndex({ dirs: [join(makeTempDir(), 'does-not-exist')] });
    expect(index.skills).toHaveLength(0);
  });
});

// ─── loadSkillBody ───────────────────────────────────────────────────────

describe('loadSkillBody', () => {
  it('returns body for an existing skill', async () => {
    const base = makeTempDir();
    writeSkill(base, 'x', 'name: x\ndescription: X.', 'The body text.');
    const index = await loadSkillIndex({ dirs: [base] });
    const body = await loadSkillBody('x', index);
    expect(body).toBe('The body text.');
  });

  it('returns undefined for unknown skill', async () => {
    const base = makeTempDir();
    const index = await loadSkillIndex({ dirs: [base] });
    const body = await loadSkillBody('nope', index);
    expect(body).toBeUndefined();
  });
});

// ─── findBuiltinSkillsDir ─────────────────────────────────────────────────

describe('findBuiltinSkillsDir', () => {
  it('locates the built-in skills/ directory containing example/SKILL.md', () => {
    const dir = findBuiltinSkillsDir();
    expect(dir).toBeDefined();
    expect(existsSync(join(dir!, 'example', 'SKILL.md'))).toBe(true);
  });
});
