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

export type SkillSourceKind = 'builtin' | 'user' | 'external' | 'plugin';

/** One owner-controlled directory that may contribute skills. */
export interface SkillSourceDefinition {
  /** Stable source id. Plugin sources use `plugin:<plugin-id>`. */
  id: string;
  kind: SkillSourceKind;
  /** Directory containing `<entry>/SKILL.md`. */
  dir: string;
  /** Plugin id or other owner identity when different from the source id. */
  ownerId?: string;
  /** Disabled owners are still scanned for management, but are not callable. */
  enabled?: boolean;
  /** Optional allowlist of frontmatter names contributed by this source. */
  include?: string[];
}

export type SkillAvailability = 'active' | 'disabled' | 'shadowed';

/** One discovered skill (frontmatter + location + lifecycle owner). */
export interface SkillIndexEntry {
  name: string;
  description: string;
  whenToUse?: string;
  model?: string;
  /** Absolute directory containing SKILL.md. */
  dir: string;
  source: SkillSourceDefinition;
  availability: SkillAvailability;
}

/** The resolved skill index. */
export interface SkillIndex {
  /** Callable skills after owner state, config disablement and name precedence. */
  skills: SkillIndexEntry[];
  /** All valid discovered skills, including disabled and shadowed entries. */
  discovered: SkillIndexEntry[];
  /** Normalized owner sources used to build this index. */
  sources: SkillSourceDefinition[];
  /** Names that were skipped due to `disabled`. */
  disabled: string[];
}

/** Options for loading the skill index. */
export interface LoadSkillIndexOptions {
  /** Legacy directories; converted to external owner sources in order. */
  dirs?: string[];
  /** Owner-aware sources. Sources are evaluated in order; first active name wins. */
  sources?: SkillSourceDefinition[];
  /** Skill names to skip. */
  disabled?: string[];
}

/** A loaded skill index + body loader, with hot-reload support. */
export interface SkillLoader {
  index: SkillIndex;
  loadBody(name: string): Promise<string | undefined>;
  /**
   * Register a body that is produced at call time instead of read from disk.
   * Used for per-run content such as the task book, which no skill file holds.
   */
  registerDynamic?(entry: SkillIndexEntry, body: () => string | undefined): void;
  /** Drop a dynamic entry again, e.g. when the run that owned it ends. */
  unregisterDynamic?(name: string): void;
  /** Re-scan skill directories and rebuild the index. New skills become visible immediately. */
  reload(): Promise<SkillIndex>;
  /** Atomically replace all dynamic sources owned by one source kind. */
  replaceOwnedSources(kind: SkillSourceKind, sources: SkillSourceDefinition[]): Promise<SkillIndex>;
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
  const discovered: SkillIndexEntry[] = [];
  const seen = new Set<string>();
  const sources = normalizeSkillSources(opts);

  for (const source of sources) {
    const base = source.dir;
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
      if (source.include && !source.include.includes(fm.name)) continue;
      const availability: SkillAvailability = source.enabled === false || disabled.has(fm.name)
        ? 'disabled'
        : seen.has(fm.name)
          ? 'shadowed'
          : 'active';
      const indexed: SkillIndexEntry = {
        name: fm.name,
        description: fm.description,
        whenToUse: fm.when_to_use,
        model: fm.model,
        dir: resolve(base, entry.name),
        source,
        availability,
      };
      discovered.push(indexed);
      if (availability !== 'active') continue;
      seen.add(fm.name);
      skills.push(indexed);
    }
  }

  return { skills, discovered, sources, disabled: [...disabled] };
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
  const disabled = [...(opts.disabled ?? [])];
  const baseSources = normalizeSkillSources(opts);
  let dynamicSources: SkillSourceDefinition[] = [];
  let index = await loadSkillIndex({ sources: baseSources, disabled });
  // Bodies produced per run rather than read from disk. Kept beside the index
  // because reload() replaces the index wholesale.
  const dynamicEntries = new Map<string, SkillIndexEntry>();
  const dynamicBodies = new Map<string, () => string | undefined>();
  const reload = async (): Promise<SkillIndex> => {
    index = await loadSkillIndex({ sources: [...baseSources, ...dynamicSources], disabled });
    return index;
  };
  return {
    get index() {
      if (dynamicEntries.size === 0) return index;
      return { ...index, skills: [...index.skills, ...dynamicEntries.values()] };
    },
    loadBody: async (name) => dynamicBodies.get(name)?.() ?? loadSkillBody(name, index),
    registerDynamic: (entry, body) => {
      dynamicEntries.set(entry.name, entry);
      dynamicBodies.set(entry.name, body);
    },
    unregisterDynamic: (name) => {
      dynamicEntries.delete(name);
      dynamicBodies.delete(name);
    },
    reload,
    replaceOwnedSources: async (kind, sources) => {
      if (sources.some((source) => source.kind !== kind)) {
        throw new Error(`Skill source replacement for ${kind} contains a different owner kind.`);
      }
      dynamicSources = [
        ...dynamicSources.filter((source) => source.kind !== kind),
        ...sources,
      ];
      return reload();
    },
  };
}

function normalizeSkillSources(opts: LoadSkillIndexOptions): SkillSourceDefinition[] {
  const sources = [
    ...(opts.sources ?? []),
    ...(opts.dirs ?? []).map((dir, index): SkillSourceDefinition => ({
      id: `legacy:${index}:${resolve(dir).toLocaleLowerCase()}`,
      kind: 'external',
      dir,
    })),
  ].map((source) => ({
    ...source,
    id: source.id.trim(),
    dir: resolve(source.dir),
    ownerId: source.ownerId?.trim() || undefined,
    enabled: source.enabled !== false,
    include: source.include ? [...new Set(source.include.map((name) => name.trim()).filter(Boolean))] : undefined,
  }));
  const ids = new Set<string>();
  for (const source of sources) {
    if (!source.id) throw new Error('Skill source id is required.');
    if (ids.has(source.id)) throw new Error(`Duplicate skill source id: ${source.id}`);
    ids.add(source.id);
  }
  return sources;
}
