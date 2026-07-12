// @littlesheep/experience — record-experience.ts
// The `record_experience` AgentTool: lets the LLM record a reusable experience
// (scenario + lesson + applicability + tags) into the ExperienceStore. This is
// the ExperienceBranch write entry point and the primary self-evolution
// channel alongside create_skill + write_memory.
//
// Semantics vs other memory tools:
//   - append_daily        → "what happened today" (ephemeral, T2, archived)
//   - write_memory        → "what's durably true"  (decisions/facts, T1 core)
//   - record_experience   → "what to do next time" (patterns, T2/T3)
//
// De-duplication: before appending, we Jaccard-compare tags against existing
// entries. If overlap ≥ 0.6, we skip the write and return duplicated:true
// rather than creating a near-duplicate. Full reinforcement (bumping
// confidence + lastReinforcedAt) would need an ExperienceStore.reinforce()
// method — not yet implemented; tracked as a follow-up in the design doc.
//
// Content composition: scenario + lesson + applicability are merged into one
// markdown string so ExperienceStore.append's validateMemoryContent covers all
// user-supplied text in a single pass (no separate sanitization needed here).
//
// Why onInvalidate callback (not a direct MemoryTree dep): the experience
// package must not depend on the (future) memory-tree package. The caller
// binds `onInvalidate: () => memoryTree.invalidateBranch('experience')`.

import { z } from 'zod';
import type { AgentTool, ToolResult } from '@littlesheep/types';
import { ExperienceStore, type ExperienceEntry } from './experience-store.js';

// ─── Tool input schema ────────────────────────────────────────────────────

const RecordExperienceInput = z.object({
  scenario: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'Triggering scenario (e.g. "SQLite WAL lock leak causing disk I/O error"). ≤200 chars.',
    ),
  lesson: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      'The reusable lesson in Markdown. Suggested structure: symptom / root cause / fix. ≤4000 chars.',
    ),
  tags: z
    .array(z.string().min(1).max(40))
    .min(1)
    .max(10)
    .describe(
      'Retrieval tags (e.g. ["sqlite","windows","concurrency"]). T2 BM25 weights tags heavily. 1-10 tags.',
    ),
  applicability: z
    .string()
    .max(500)
    .optional()
    .describe(
      'When this lesson applies (e.g. "Windows + Electron multi-window + SQLite"). Agent should check this before reusing the lesson.',
    ),
  severity: z
    .enum(['info', 'warning', 'critical'])
    .default('info')
    .describe(
      'info = general note; warning = pitfall to avoid; critical = key lesson (higher T2 priority).',
    ),
  relatedProject: z
    .string()
    .max(80)
    .optional()
    .describe('Related project id (optional, for cross-project retrieval).'),
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Severity → initial confidence. critical lessons surface higher in T2. */
function severityToConfidence(s: 'info' | 'warning' | 'critical'): number {
  if (s === 'critical') return 0.9;
  if (s === 'warning') return 0.7;
  return 0.5;
}

/**
 * Jaccard similarity between two tag sets (case-insensitive).
 * 0 = disjoint, 1 = identical. Used for near-duplicate detection.
 */
function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a.map((t) => t.toLowerCase()));
  const sb = new Set(b.map((t) => t.toLowerCase()));
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Compose scenario + lesson + applicability into one markdown content blob.
 * ExperienceStore.append runs validateMemoryContent on this single string, so
 * all user-supplied text is sanitized in one pass.
 */
function composeContent(
  scenario: string,
  lesson: string,
  applicability?: string,
): string {
  const parts = [`**Scenario:** ${scenario.trim()}`, '', lesson.trim()];
  if (applicability && applicability.trim()) {
    parts.push('', `**Applicability:** ${applicability.trim()}`);
  }
  return parts.join('\n');
}

/** Jaccard threshold above which a new experience is treated as a duplicate. */
const DUPLICATE_THRESHOLD = 0.6;

/** Composed content cap. ExperienceStore.append re-validates with its own
 *  maxLength (configure ≥ 5000 at construction); this is an early-fail guard. */
const MAX_COMPOSED_LENGTH = 4500;

// ─── Deps ─────────────────────────────────────────────────────────────────

export interface RecordExperienceToolDeps {
  /** The shared ExperienceStore — appended to + searched for de-dup. */
  store: ExperienceStore;
  /**
   * Called after a successful write so the caller can invalidate any
   * ExperienceBranch cache. Bind to `() => memoryTree.invalidateBranch('experience')`.
   * Optional — no-op if unset.
   */
  onInvalidate?: () => void;
}

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Build the `record_experience` tool. Writes a structured experience to the
 * ExperienceStore with Jaccard tag-based de-duplication.
 *
 * The tool never throws — all errors are returned as `{ ok: false, error }`,
 * per the AgentTool contract.
 */
export function createRecordExperienceTool(deps: RecordExperienceToolDeps): AgentTool {
  return {
    name: 'record_experience',
    description:
      'Record a reusable experience to the experience library. An experience = scenario + lesson + tags + applicability, retrieved for similar future situations. ' +
      'Use when: summarizing a pitfall, capturing a reusable pattern, or confirming a solution works. ' +
      'Do not use for daily logs (append_daily) or cross-project core decisions (write_memory).',
    inputSchema: RecordExperienceInput,
    requiresApproval: true,
    async execute(input): Promise<ToolResult> {
      const start = Date.now();
      try {
        const parsed = RecordExperienceInput.parse(input);
        const { scenario, lesson, tags, applicability, severity, relatedProject } = parsed;

        // 1. Compose content (one blob so ExperienceStore.append's
        //    validateMemoryContent covers all user text in one pass).
        const content = composeContent(scenario, lesson, applicability);

        // 2. Early-fail guard on composed length. The ExperienceStore also
        //    enforces maxLength on append, but we want a clear error before
        //    the de-dup scan if the lesson is obviously too long.
        if (content.length > MAX_COMPOSED_LENGTH) {
          return {
            callId: '',
            ok: false,
            error:
              `composed content too long (${content.length} chars, max ${MAX_COMPOSED_LENGTH}). ` +
              `Reduce the lesson length.`,
            durationMs: Date.now() - start,
          };
        }

        // 3. De-duplication: Jaccard on tags against existing entries.
        //    ExperienceStore has no reinforce() yet, so duplicates are skipped.
        const existing = await deps.store.list();
        let duplicate: ExperienceEntry | undefined;
        for (const e of existing) {
          if (jaccard(e.tags, tags) >= DUPLICATE_THRESHOLD) {
            duplicate = e;
            break;
          }
        }
        if (duplicate) {
          return {
            callId: '',
            ok: true,
            output:
              `Similar experience already exists (id: ${duplicate.id}, tags overlap ≥ ${DUPLICATE_THRESHOLD}).\n` +
              `Skipped creating a duplicate. To reinforce, edit the existing entry or update its tags.\n` +
              `Existing tags: ${duplicate.tags.join(', ')}`,
            durationMs: Date.now() - start,
            meta: {
              duplicated: true,
              existingId: duplicate.id,
              existingTags: duplicate.tags,
              jaccardThreshold: DUPLICATE_THRESHOLD,
            },
          };
        }

        // 4. Build tag list: user tags + severity tag + optional project tag.
        //    severity/project are namespaced so they don't collide with user tags
        //    but are still retrievable via ExperienceStore.list({ tag }).
        const fullTags = [...tags];
        fullTags.push(`severity:${severity}`);
        if (relatedProject) fullTags.push(`project:${relatedProject}`);

        // 5. Append via ExperienceStore (validates content internally;
        //    may throw on injection-pattern match — caught below).
        const entry = await deps.store.append({
          category: 'capture',
          content,
          source: 'record_experience',
          tags: fullTags,
          confidence: severityToConfidence(severity),
        });

        // 6. Notify caller to invalidate any ExperienceBranch cache.
        deps.onInvalidate?.();

        return {
          callId: '',
          ok: true,
          output:
            `Experience recorded (id: ${entry.id}).\n` +
            `Scenario: ${scenario.trim()}\n` +
            `Tags: ${tags.join(', ')}\n` +
            `Severity: ${severity} (confidence: ${entry.confidence.toFixed(2)})`,
          durationMs: Date.now() - start,
          meta: {
            duplicated: false,
            experienceId: entry.id,
            tags: entry.tags,
            confidence: entry.confidence,
            category: entry.category,
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
