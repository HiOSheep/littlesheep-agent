// @littlesheep/memory-tree — project-index.ts
// Read-only access to ~/.littlesheep/projects/index.json.
//
// This is the T1 data source for ProjectMemoryBranch (design doc §7.3): a list
// of known projects with their paths and last-active timestamps. The index is
// small (~80 tokens for 10 projects) and always injected in T1 so the agent
// knows what projects exist.
//
// Pattern: mirrors snapshot-index.ts:62-72 (existsSync + readFile + JSON.parse
// + catch { return [] }). Read-only here — write-back of lastActiveAt is M5.
// No corrupt backup: read-only access has no data-loss risk (the file is only
// ever written by the project registrar, not by this reader). If the file is
// corrupt, we return an empty index and log a warning; the next write will
// overwrite the corrupt content.
//
// Malformed entry filtering: each entry must have string `id`, `path`, and
// `lastActiveAt`. Entries missing these fields are dropped (defensive against
// hand-edited or partially-written JSON).

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { ProjectEntry, ProjectIndex } from './types.js';

/** Sentinel for "no projects" — returned when index is missing or corrupt. */
const EMPTY_INDEX: ProjectIndex = { projects: [] };

/**
 * Read the project index from disk.
 *
 * Returns `{ projects: [] }` if:
 *   - The file does not exist (fresh install — no projects registered yet)
 *   - The file cannot be read (locked, permission)
 *   - The file is not valid JSON (corrupt)
 *   - The JSON is valid but not the expected shape
 *
 * Malformed entries (missing/incorrect-type fields) are filtered out; valid
 * entries in the same file are still returned. This is more lenient than
 * "all or nothing" — a single bad entry shouldn't hide the other 9.
 *
 * @param indexPath Absolute path to projects/index.json
 */
export async function readProjectIndex(indexPath: string): Promise<ProjectIndex> {
  if (!existsSync(indexPath)) return EMPTY_INDEX;

  let raw: string;
  try {
    raw = await readFile(indexPath, 'utf8');
  } catch {
    // File exists but can't be read (locked, permission). No data to back up
    // (we can't read it); return empty and let the caller proceed.
    return EMPTY_INDEX;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // Corrupt JSON. Unlike ExperienceStore, we do NOT back up the corrupt file
    // here: this reader is read-only and the file is owned by the project
    // registrar (M5). A backup would duplicate responsibility. We log to
    // console.warn so operators notice, and return empty.
    // eslint-disable-next-line no-console
    console.warn(
      `[memory-tree] projects/index.json at ${indexPath} is corrupt — ` +
        `returning empty project list. The next write will overwrite it.`,
    );
    return EMPTY_INDEX;
  }

  if (!isValidProjectIndex(data)) {
    // Valid JSON but wrong shape (e.g. { projects: "not-an-array" }).
    return EMPTY_INDEX;
  }

  // Filter malformed entries (defensive against hand-edited JSON).
  const valid = data.projects.filter(isValidProjectEntry);
  return { projects: valid };
}

/** Type guard: validate that parsed JSON matches ProjectIndex shape. */
function isValidProjectIndex(data: unknown): data is { projects: unknown[] } {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return Array.isArray(obj.projects);
}

/** Type guard: validate a single project entry has correct field types. */
function isValidProjectEntry(data: unknown): data is ProjectEntry {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.path === 'string' &&
    typeof obj.lastActiveAt === 'string' &&
    obj.id.length > 0 &&
    obj.path.length > 0
  );
}
