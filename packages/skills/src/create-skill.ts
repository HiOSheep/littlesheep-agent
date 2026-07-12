// @littlesheep/skills — create-skill.ts
// The `create_skill` AgentTool: lets the LLM write a new SKILL.md to the
// user skills directory and hot-reload the skill index so the new skill
// is immediately available via `use_skill` — no gateway restart needed.
//
// This is the core of "self-evolution": the agent can create new reusable
// skills from patterns it observes in conversation, making it genuinely
// "learn" new capabilities over time (within the limits of instruction-based
// skills, not weight updates).

import { z } from 'zod';
import type { AgentTool, ToolResult } from '@littlesheep/types';
import type { SkillLoader } from './loader.js';
import { writeSkillFile } from './loader.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const SINGLE_LINE_RE = /^[^\n\r]*$/;

const CreateSkillInput = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(NAME_RE, 'Skill name must be lowercase alphanumeric with hyphens (e.g. "code-review")')
    .describe('Unique skill name (lowercase, hyphens OK, e.g. "code-review")'),
  description: z
    .string()
    .min(1)
    .max(200)
    .regex(SINGLE_LINE_RE, 'Description must be a single line')
    .describe('One-line summary of what the skill does (max 200 chars)'),
  when_to_use: z
    .string()
    .max(200)
    .regex(SINGLE_LINE_RE, 'when_to_use must be a single line')
    .optional()
    .describe('When the agent should use this skill (optional, but recommended)'),
  body: z
    .string()
    .min(1)
    .describe('Full skill body in Markdown — instructions the agent follows when this skill is loaded'),
});

export interface CreateSkillToolDeps {
  /** The shared SkillLoader — reloaded after writing so use_skill sees the new skill. */
  loader: SkillLoader;
  /** Where to write new skills (e.g. ~/.littlesheep/skills). */
  skillsDir: string;
}

/**
 * Build the `create_skill` tool.
 * Writes `<skillsDir>/<name>/SKILL.md` with frontmatter + body, then reloads
 * the SkillLoader index so the new skill is immediately discoverable.
 */
export function createCreateSkillTool(deps: CreateSkillToolDeps): AgentTool {
  return {
    name: 'create_skill',
    description:
      'Create a new reusable skill. Writes a SKILL.md file to the skills directory and hot-reloads the skill index so the new skill is immediately available via use_skill. ' +
      'Use this when the user wants to create a new skill, or when you identify a recurring pattern worth automating. ' +
      'After creation, the skill is permanently saved and available in future sessions.',
    inputSchema: CreateSkillInput,
    requiresApproval: true,
    async execute(input): Promise<ToolResult> {
      const start = Date.now();
      try {
        const parsed = CreateSkillInput.parse(input);
        const { name, description, when_to_use, body } = parsed;

        // Check for name collision against the live index.
        const existing = deps.loader.index.skills.find((s) => s.name === name);
        if (existing) {
          return {
            callId: '',
            ok: false,
            error: `A skill named "${name}" already exists (at ${existing.dir}). Choose a different name or delete the existing skill first.`,
            durationMs: Date.now() - start,
          };
        }

        // Write the SKILL.md file.
        const skillFile = await writeSkillFile({
          skillsDir: deps.skillsDir,
          name,
          description,
          whenToUse: when_to_use,
          body,
        });

        // Hot-reload the skill index so use_skill sees the new skill immediately.
        await deps.loader.reload();

        return {
          callId: '',
          ok: true,
          output:
            `Skill "${name}" created successfully at ${skillFile}.\n` +
            `It is now available — call use_skill("${name}") to use it.\n` +
            `The skill is permanently saved and will be available in future sessions.`,
          durationMs: Date.now() - start,
          meta: { skillName: name, skillFile },
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
