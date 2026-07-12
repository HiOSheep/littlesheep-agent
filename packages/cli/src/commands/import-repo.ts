// @littlesheep/cli — commands/import-repo.ts
// `littlesheep memory import-repo <path-or-url>` — distill a repository's
// durable knowledge into the experience DB via LLM.
//
// This is the second write path into ExperienceStore (the first being EVOLVE
// double-write). External repo content is a high-risk injection vector, so
// every distilled entry passes through validateMemoryContent inside
// ExperienceStore.append. Rejects are skipped with a warning (no quarantine —
// quarantine is memory-tier only).
//
// URL sources are shallow-cloned via `git clone --depth 1` to a tmpdir; the
// user running this CLI command is explicit authorization (the agent exec
// approval flow is not consulted). tmpdir is cleaned up in `finally`.

import { readFile, readdir, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { LlmClient, ChatMessage } from '@littlesheep/llm';
import { callLlmForJson } from '@littlesheep/harness';
import type { ExperienceStore } from '@littlesheep/experience';

const execFileP = promisify(execFile);

export interface ImportRepoFlags {
  /** Source path or git URL. */
  source?: string;
  /** Provenance repo name (default: inferred from source). */
  name?: string;
  /** Max chars to scan. Default 50000. */
  limit?: number;
  /** Override model ref (provider/model). */
  model?: string;
}

export const IMPORT_REPO_USAGE = `Usage: littlesheep memory import-repo <path-or-url> [options]

  Distill a repository's durable knowledge into the experience DB via LLM.
  External content is validated against injection patterns on insert.

  Arguments:
    <path-or-url>         Local path or git URL (http(s):// or git@)

  Options:
    --name <repo-name>    Provenance label (default: inferred from source)
    --limit <chars>       Max chars to scan (default: 50000)
    --model <ref>         Override model (provider/model)
`;

const DEFAULT_LIMIT = 50000;

const SYSTEM_PROMPT = `You are extracting durable, reusable knowledge from a repository for an agent's experience database. Return ONLY JSON: {"entries":[{"content":"...","tags":["..."],"confidence":0.0-1.0}]}

Skip README boilerplate (badges, install steps, CI config) — extract concepts, patterns, gotchas, design decisions. If nothing durable, return {"entries":[]}.`;

interface DistilledEntry {
  content?: unknown;
  tags?: unknown;
  confidence?: unknown;
}

interface Distilled {
  entries?: unknown;
}

interface CleanEntry {
  content: string;
  tags: string[];
  confidence: number;
}

/** True if the source string looks like a git URL. */
function isUrl(s: string): boolean {
  return s.startsWith('http://') || s.startsWith('https://') || s.startsWith('git@');
}

/** Infer a repo name from a path or URL (last path segment minus .git). */
function inferName(source: string): string {
  if (isUrl(source)) {
    const m = source.match(/\/([^/]+?)(?:\.git)?(?:\?.*)?$/);
    return m?.[1] ?? 'repo';
  }
  return basename(source.replace(/[\\/]+$/, ''));
}

function parseLimit(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Parse import-repo flags from argv (the slice after 'memory import-repo'). */
export function parseImportRepoFlags(argv: string[]): ImportRepoFlags {
  const out: ImportRepoFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--name') out.name = argv[++i] ?? '';
    else if (a.startsWith('--name=')) out.name = a.slice('--name='.length);
    else if (a === '--limit') out.limit = parseLimit(argv[++i]);
    else if (a.startsWith('--limit=')) out.limit = parseLimit(a.slice('--limit='.length));
    else if (a === '--model') out.model = argv[++i] ?? '';
    else if (a.startsWith('--model=')) out.model = a.slice('--model='.length);
    else if (!a.startsWith('-') && out.source === undefined) out.source = a;
  }
  return out;
}

/** Coerce raw LLM output into clean entries; drop empty/malformed ones. */
function cleanEntries(raw: Distilled | null): CleanEntry[] {
  if (!raw || !Array.isArray(raw.entries)) return [];
  const out: CleanEntry[] = [];
  for (const e of raw.entries) {
    if (typeof e !== 'object' || e === null) continue;
    const obj = e as DistilledEntry;
    const content = typeof obj.content === 'string' ? obj.content.trim() : '';
    if (content === '') continue;
    const tags = Array.isArray(obj.tags)
      ? obj.tags.filter((t): t is string => typeof t === 'string')
      : [];
    let confidence = typeof obj.confidence === 'number' ? obj.confidence : 0.5;
    if (confidence < 0) confidence = 0;
    if (confidence > 1) confidence = 1;
    out.push({ content, tags, confidence });
  }
  return out;
}

/** Recursively collect *.md/*.mdx files under dir (skipping node_modules/.git). */
async function collectMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    let s;
    try {
      s = await stat(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      const sub = await collectMarkdown(p);
      out.push(...sub);
    } else if (s.isFile() && (name.endsWith('.md') || name.endsWith('.mdx'))) {
      out.push(p);
    }
  }
  return out;
}

/** Scan a repo dir for documentation files, returning concatenated content (≤ limit). */
async function scanRepoFiles(dir: string, limit: number): Promise<string> {
  const chunks: string[] = [];
  let total = 0;

  // Priority order: AGENTS.* > README.* (root), then docs/**/*.md.
  const priorityFiles = [
    'AGENTS.md', 'AGENTS.mdx',
    'README.md', 'README.MD', 'README.rst', 'README.txt',
  ];
  for (const f of priorityFiles) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const content = await readFile(p, 'utf8');
    chunks.push(`### ${f}\n\n${content}`);
    total += content.length;
    if (total >= limit) return chunks.join('\n\n').slice(0, limit);
  }

  const docsDir = join(dir, 'docs');
  if (existsSync(docsDir)) {
    const docs = await collectMarkdown(docsDir);
    docs.sort();
    for (const p of docs) {
      const content = await readFile(p, 'utf8');
      const rel = p.slice(docsDir.length + 1);
      chunks.push(`### docs/${rel}\n\n${content}`);
      total += content.length;
      if (total >= limit) break;
    }
  }

  return chunks.join('\n\n').slice(0, limit);
}

export interface RunImportRepoOptions {
  flags: ImportRepoFlags;
  llm: LlmClient;
  model: string;
  experienceStore: ExperienceStore;
  /** Injectable stdout (tests). */
  out?: (msg: string) => void;
  /** Injectable stderr (tests). */
  err?: (msg: string) => void;
}

/** Execute an import-repo command. Sets process.exitCode on failure. */
export async function runImportRepo(opts: RunImportRepoOptions): Promise<void> {
  const out = opts.out ?? ((m: string) => process.stdout.write(m));
  const err = opts.err ?? ((m: string) => process.stderr.write(m));

  const source = opts.flags.source;
  if (!source) {
    err(IMPORT_REPO_USAGE + '\n');
    process.exitCode = 2;
    return;
  }

  const repoName = opts.flags.name || inferName(source);
  const limit = opts.flags.limit ?? DEFAULT_LIMIT;

  // 1. Resolve source: clone URL or use local path.
  let repoDir: string;
  let tmpDir: string | null = null;
  if (isUrl(source)) {
    tmpDir = join(tmpdir(), `littlesheep-import-${Date.now()}`);
    try {
      await execFileP('git', ['clone', '--depth', '1', source, tmpDir]);
      repoDir = tmpDir;
    } catch (e) {
      err(`git clone failed: ${(e as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
  } else {
    if (!existsSync(source)) {
      err(`Path not found: ${source}\n`);
      process.exitCode = 1;
      return;
    }
    let s;
    try {
      s = await stat(source);
    } catch (e) {
      err(`Cannot stat path: ${(e as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
    if (!s.isDirectory()) {
      err(`Not a directory: ${source}\n`);
      process.exitCode = 1;
      return;
    }
    repoDir = source;
  }

  try {
    // 2. Scan + 3. Truncate to limit.
    const content = await scanRepoFiles(repoDir, limit);
    if (content.trim() === '') {
      err(`No documentation files found in ${repoName}.\n`);
      err('Expected: README.md, AGENTS.md, or docs/**/*.md\n');
      process.exitCode = 1;
      return;
    }

    // 4+5. LLM distill into structured entries.
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Repo: ${repoName}\n\n${content}` },
    ];
    const { parsed } = await callLlmForJson<Distilled>(opts.llm, opts.model, messages, {
      maxAttempts: 2,
      maxTokens: 2000,
    });

    const entries = cleanEntries(parsed);
    if (entries.length === 0) {
      out(`No durable entries extracted from ${repoName}.\n`);
      return;
    }

    // 6. Insert into experience DB. Each append validates content against
    //    injection patterns; rejects throw and are skipped with a warning.
    let imported = 0;
    let rejected = 0;
    for (const e of entries) {
      try {
        await opts.experienceStore.append({
          category: 'repo-import',
          content: e.content,
          confidence: e.confidence,
          source: 'import-repo',
          provenance: repoName,
          tags: e.tags,
        });
        imported++;
      } catch (e2) {
        err(`Warning: rejected entry from ${repoName}: ${(e2 as Error).message}\n`);
        rejected++;
      }
    }

    // 7. Output summary.
    out(
      `Imported ${imported} entries from ${repoName}`
      + (rejected > 0 ? ` (${rejected} rejected)` : '')
      + '\n',
    );
  } catch (e) {
    // Operational failure (LLM error, scan error, etc.). Per-entry append
    // rejections are already handled above; this catches the rest.
    err(`import-repo failed: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    // Cleanup tmpdir (URL clone only). Best-effort.
    if (tmpDir) {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}
