// @littlesheep/memory-core — write-memory.ts
// The `write_memory` AgentTool: writes a structured entry to MEMORY.md — the
// T1 long-term core memory. MEMORY.md uses a three-section layout
// (Key Decisions / Long-term Facts / Lessons Learned) — see the memory-tree
// design doc §7.5. Each entry is `<title> + <content>` so the agent can update
// in place (replace mode) or append new entries.
//
// Write path:
//   zod parse → injection-defence sanitize → read existing →
//   parse + merge by section+title → atomic write → notify cache invalidation
//
// Why no vector index: MEMORY.md is T1 (always injected above the cache
// boundary), not a T3 search target. T3 deep search covers archives +
// experience, not the core file. Adding MEMORY.md to the vector DB would
// duplicate what T1 already injects every turn.
//
// Why onInvalidate callback (not a direct MemoryTree dep): memory-core must
// not depend on the (future) memory-tree package — that would create a cycle
// (memory-tree depends on memory-core for MemoryStore). The caller (gateway/
// app) binds `onInvalidate: () => memoryTree.invalidateBranch('personal-memory')`.

import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentTool, ToolResult } from '@littlesheep/types';
import { validateMemoryContent } from '@littlesheep/safety';
import { atomicWrite } from './atomic-write.js';

// ─── MEMORY.md structure ─────────────────────────────────────────────────

/**
 * The three canonical sections of MEMORY.md. Order is fixed so the file has a
 * stable shape regardless of which sections have entries (see §7.5).
 */
const SECTION_ORDER = ['Key Decisions', 'Long-term Facts', 'Lessons Learned'] as const;
type SectionName = (typeof SECTION_ORDER)[number];
const SECTION_NAMES: readonly SectionName[] = SECTION_ORDER;

/** A single titled entry within a section. */
interface MemoryEntry {
  title: string;
  content: string;
}

/** Parsed MEMORY.md: sections keyed by name, entries in file order. */
interface MemoryFile {
  sections: Partial<Record<SectionName, MemoryEntry[]>>;
}

// ─── Parser / renderer ────────────────────────────────────────────────────

/**
 * Parse MEMORY.md into sections + entries. Tolerant of missing headers and
 * free-form text outside entries (ignored).
 *
 * Entry format (canonical, see renderMemoryFile):
 *   - **<title>**
 *     <content line 1>
 *     <content line 2>
 *
 * Content lines are indented by 2 spaces; the parser strips that indent.
 * An entry ends at the next `- **` line, the next `## ` header, or EOF.
 */
function parseMemoryFile(raw: string): MemoryFile {
  const sections: MemoryFile['sections'] = {};
  let currentSection: SectionName | null = null;
  let currentEntry: MemoryEntry | null = null;

  const ensure = (name: SectionName): MemoryEntry[] => {
    if (!sections[name]) sections[name] = [];
    return sections[name]!;
  };

  for (const line of raw.split('\n')) {
    const secMatch = line.match(/^## (.+?)\s*$/);
    if (secMatch && SECTION_NAMES.includes(secMatch[1] as SectionName)) {
      currentSection = secMatch[1] as SectionName;
      ensure(currentSection);
      currentEntry = null;
      continue;
    }
    const entryMatch = line.match(/^- \*\*(.+?)\*\*\s*$/);
    if (entryMatch && currentSection) {
      currentEntry = { title: entryMatch[1]!.trim(), content: '' };
      ensure(currentSection).push(currentEntry);
      continue;
    }
    if (currentEntry) {
      // Content continuation line — strip the 2-space indent.
      const stripped = line.replace(/^  /, '');
      currentEntry.content = currentEntry.content
        ? currentEntry.content + '\n' + stripped
        : stripped;
    }
    // Lines before any entry / outside a section are ignored (e.g. `# Memory`).
  }
  return { sections };
}

/** Render a MemoryFile back to canonical markdown. */
function renderMemoryFile(file: MemoryFile): string {
  const lines: string[] = ['# Memory', ''];
  for (const name of SECTION_ORDER) {
    const entries = file.sections[name];
    if (!entries || entries.length === 0) continue;
    lines.push(`## ${name}`, '');
    for (const e of entries) {
      lines.push(`- **${e.title}**`);
      // Re-indent content lines by 2 spaces so they nest under the list item.
      const indented = e.content
        .split('\n')
        .map((l) => (l.length ? `  ${l}` : ''))
        .join('\n');
      lines.push(indented, '');
    }
  }
  return lines.join('\n');
}

/**
 * Merge a new entry into the file by section + title.
 * - replace mode + existing title → overwrite in place.
 * - append mode, or replace mode with no match → push to end of section.
 */
function mergeMemoryEntry(
  file: MemoryFile,
  section: SectionName,
  title: string,
  content: string,
  mode: 'append' | 'replace',
): { replacedExisting: boolean } {
  if (!file.sections[section]) file.sections[section] = [];
  const entries = file.sections[section]!;
  const idx = entries.findIndex((e) => e.title === title);
  if (mode === 'replace' && idx >= 0) {
    entries[idx] = { title, content };
    return { replacedExisting: true };
  }
  entries.push({ title, content });
  return { replacedExisting: false };
}

// ─── Tool input schema ────────────────────────────────────────────────────

const WriteMemoryInput = z.object({
  section: z
    .enum(SECTION_ORDER)
    .describe('Target section in MEMORY.md'),
  title: z
    .string()
    .min(1)
    .max(80)
    .describe(
      'Entry title (single line, ≤80 chars). Unique within a section; replace mode matches by exact title.',
    ),
  content: z
    .string()
    .min(1)
    .max(2000)
    .describe('Entry body in Markdown (1-3 paragraphs, ≤2000 chars).'),
  mode: z
    .enum(['append', 'replace'])
    .default('append')
    .describe(
      'append = add a new entry; replace = overwrite an existing entry with the same title (appends if not found).',
    ),
});

// ─── Deps ─────────────────────────────────────────────────────────────────

export interface WriteMemoryToolDeps {
  /** Root data dir (e.g. ~/.littlesheep). MEMORY.md is read/written here. */
  dataDir: string;
  /**
   * Called after a successful write so the caller can invalidate any
   * PersonalMemoryBranch cache. Bind to `() => memoryTree.invalidateBranch('personal-memory')`.
   * Optional — no-op if unset.
   */
  onInvalidate?: () => void;
}

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Build the `write_memory` tool. Writes a structured entry to MEMORY.md
 * (three-section layout) using atomic write + title-based dedup.
 *
 * The tool never throws — all errors are returned as `{ ok: false, error }`,
 * per the AgentTool contract.
 */
export function createWriteMemoryTool(deps: WriteMemoryToolDeps): AgentTool {
  const memoryPath = join(deps.dataDir, 'MEMORY.md');

  return {
    name: 'write_memory',
    description:
      'Write a long-term memory entry to MEMORY.md. Only record durable, cross-session content: key decisions, long-term facts, lessons learned. ' +
      'Do not use for ephemeral context (use append_daily instead). ' +
      'MEMORY.md has three sections: Key Decisions / Long-term Facts / Lessons Learned. ' +
      'Use replace mode to update an existing entry by title; append mode adds a new entry.',
    inputSchema: WriteMemoryInput,
    requiresApproval: true,
    async execute(input): Promise<ToolResult> {
      const start = Date.now();
      try {
        const parsed = WriteMemoryInput.parse(input);
        const { section, title, content, mode } = parsed;
        const cleanTitle = title.trim();

        // 1. Injection defence: strip zero-width chars + block injection patterns.
        //    zod already enforces max length; this sanitizes the content.
        const guard = validateMemoryContent(content, { maxLength: 2000 });
        if (!guard.ok || guard.cleaned === undefined) {
          return {
            callId: '',
            ok: false,
            error: `content rejected: ${guard.reason} (pattern: ${guard.matchedPatternId ?? 'n/a'})`,
            durationMs: Date.now() - start,
          };
        }
        const cleanedContent = guard.cleaned ?? content;

        // 2. Read existing MEMORY.md (tolerant of missing file — first write).
        let existing = '';
        if (existsSync(memoryPath)) {
          existing = await readFile(memoryPath, 'utf8');
        }
        const beforeBytes = Buffer.byteLength(existing, 'utf8');

        // 3. Parse + merge by section + title.
        const file = parseMemoryFile(existing);
        const { replacedExisting } = mergeMemoryEntry(
          file,
          section,
          cleanTitle,
          cleanedContent,
          mode,
        );
        const rendered = renderMemoryFile(file);
        const afterBytes = Buffer.byteLength(rendered, 'utf8');

        // 4. Atomic write (tmp + rename) — see atomic-write.ts.
        await atomicWrite(memoryPath, rendered);

        // 5. Notify caller to invalidate any PersonalMemoryBranch cache.
        deps.onInvalidate?.();

        return {
          callId: '',
          ok: true,
          output:
            `Memory entry written to MEMORY.md (section: ${section}, title: "${cleanTitle}", mode: ${mode}).\n` +
            (replacedExisting
              ? 'Replaced an existing entry with the same title.\n'
              : '') +
            `File: ${memoryPath}`,
          durationMs: Date.now() - start,
          meta: {
            section,
            title: cleanTitle,
            mode,
            replacedExisting,
            bytesAdded: afterBytes - beforeBytes,
            file: memoryPath,
          },
        };
      } catch (err) {
        return {
          callId: '',
          ok: false,
          error: (err as Error).message,
          durationMs: Date.now() - start,
        };
      }
    },
  };
}
