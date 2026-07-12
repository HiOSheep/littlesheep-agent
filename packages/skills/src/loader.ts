// @littlesheep/skills — loader.ts
// Scans skill directories for SKILL.md files, parses YAML frontmatter
// (tiny custom parser — no `yaml` dependency), and exposes a SkillLoader
// for the gateway to register a `use_skill` tool.
// Supports hot-reload: after create_skill writes a new SKILL.md, the loader
// can re-scan directories to pick up the new skill without a gateway restart.

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// ─── Types ───────────────────────────────────────────────────────────────

/** One entry in the skill index (frontmatter + location). */
export interface SkillIndexEntry {
  name: string;
  description: string;
  whenToUse?: string;
  model?: string;
  /** Absolute directory containing SKILL.md. */
  dir: string;
}

/** The resolved skill index. */
export interface SkillIndex {
  skills: SkillIndexEntry[];
  /** Names that were skipped due to `disabled`. */
  disabled: string[];
}

/** Options for loading the skill index. */
export interface LoadSkillIndexOptions {
  /** Directories to scan for `<name>/SKILL.md`. */
  dirs: string[];
  /** Skill names to skip. */
  disabled?: string[];
}

/** A loaded skill index + body loader, with hot-reload support. */
export interface SkillLoader {
  index: SkillIndex;
  loadBody(name: string): Promise<string | undefined>;
  /** Re-scan skill directories and rebuild the index. New skills become visible immediately. */
  reload(): Promise<SkillIndex>;
}

// ─── Frontmatter schema ───────────────────────────────────────────────────

const SkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  when_to_use: z.string().optional(),
  model: z.string().optional(),
});

/** Result of parsing a SKILL.md file. */
export interface ParsedSkillFile {
  frontmatter: Record<string, string>;
  body: string;
}

// ─── Frontmatter parser (no YAML dep) ────────────────────────────────────

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Split a SKILL.md into frontmatter (key:value) + body.
 * Returns null if no frontmatter block is present.
 * Handles BOM and CRLF (Windows).
 */
export function parseSkillFile(raw: string): ParsedSkillFile | null {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;
  const block = match[1] ?? '';
  const body = raw.slice(match[0].length);
  const frontmatter: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key.length === 0) continue;
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

// ─── Built-in skills directory ────────────────────────────────────────────

/**
 * Walk up from this module's location looking for a `skills/` dir
 * containing `example/SKILL.md`. Returns undefined if not found
 * (e.g. published package without bundled skills).
 */
export function findBuiltinSkillsDir(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'skills', 'example', 'SKILL.md');
    if (existsSync(candidate)) {
      return join(dir, 'skills');
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Scan each directory for `<entry>/SKILL.md`, parse + validate frontmatter,
 * skip disabled names, dedupe by name (first directory wins).
 */
export async function loadSkillIndex(opts: LoadSkillIndexOptions): Promise<SkillIndex> {
  const disabled = new Set(opts.disabled ?? []);
  const skills: SkillIndexEntry[] = [];
  const seen = new Set<string>();

  for (const base of opts.dirs) {
    if (!existsSync(base)) continue;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(base, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      let raw: string;
      try {
        raw = await readFile(skillFile, 'utf8');
      } catch {
        continue;
      }
      const parsed = parseSkillFile(raw);
      if (!parsed) continue;
      const validation = SkillFrontmatterSchema.safeParse(parsed.frontmatter);
      if (!validation.success) continue;
      const fm = validation.data;
      if (disabled.has(fm.name)) continue;
      if (seen.has(fm.name)) continue;
      seen.add(fm.name);
      skills.push({
        name: fm.name,
        description: fm.description,
        whenToUse: fm.when_to_use,
        model: fm.model,
        dir: resolve(base, entry.name),
      });
    }
  }

  return { skills, disabled: [...disabled] };
}

/** Read the body of a skill by name. Returns undefined if not found. */
export async function loadSkillBody(name: string, index: SkillIndex): Promise<string | undefined> {
  const entry = index.skills.find((s) => s.name === name);
  if (!entry) return undefined;
  const raw = await readFile(join(entry.dir, 'SKILL.md'), 'utf8');
  const parsed = parseSkillFile(raw);
  return parsed?.body ?? '';
}

/**
 * Write a SKILL.md file to `<skillsDir>/<name>/SKILL.md`.
 * Creates the directory if it doesn't exist.
 * Returns the absolute path to the written file.
 */
export async function writeSkillFile(opts: {
  skillsDir: string;
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
}): Promise<string> {
  const { skillsDir, name, description, whenToUse, body } = opts;
  const skillDir = join(skillsDir, name);
  const skillFile = join(skillDir, 'SKILL.md');

  const lines = ['---', `name: ${name}`, `description: ${description}`];
  if (whenToUse) lines.push(`when_to_use: ${whenToUse}`);
  lines.push('---', '', body.trim(), '');

  await mkdir(skillDir, { recursive: true });
  await writeFile(skillFile, lines.join('\n'), 'utf8');
  return skillFile;
}

/**
 * Build a SkillLoader: loads index once, exposes loadBody + reload.
 * The index is stored in a mutable closure so reload() updates it in-place,
 * and subsequent loadBody() calls see the new index.
 */
export async function createSkillLoader(opts: LoadSkillIndexOptions): Promise<SkillLoader> {
  let index = await loadSkillIndex(opts);
  return {
    get index() {
      return index;
    },
    loadBody: (name) => loadSkillBody(name, index),
    reload: async () => {
      index = await loadSkillIndex(opts);
      return index;
    },
  };
}
