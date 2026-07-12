// @littlesheep/skills — use_skill.ts
// The `use_skill` AgentTool: lets the LLM load a skill body on-demand.
// The available skill names are embedded in the tool description so the
// LLM can discover them without prompt injection.
// Error messages use the live loader.index so newly created skills appear
// in the "Available:" list immediately after a hot-reload.

import { z } from 'zod';
import type { AgentTool, ToolResult } from '@littlesheep/types';
import type { SkillLoader } from './loader.js';

const UseSkillInput = z.object({
  name: z.string().describe('Skill name to load (must match a name from the description).'),
});

/**
 * Build the `use_skill` tool bound to a SkillLoader.
 * Returns the skill body (markdown) on success, or an error message.
 * The "Available:" list in error messages is computed at call time from the
 * live loader.index, so it reflects skills created via `create_skill` mid-session.
 */
export function createUseSkillTool(loader: SkillLoader): AgentTool {
  const names = loader.index.skills.map((s) => s.name).join(', ');
  return {
    name: 'use_skill',
    description: `Load a skill body by name. Available skills: ${names || '(none)'}. Call this when you want to follow a skill's instructions.`,
    inputSchema: UseSkillInput,
    async execute(input): Promise<ToolResult> {
      const start = Date.now();
      try {
        const { name } = UseSkillInput.parse(input);
        const body = await loader.loadBody(name);
        if (body === undefined) {
          // Use live index so newly created skills appear in the available list.
          const available = loader.index.skills.map((s) => s.name).join(', ');
          return {
            callId: '',
            ok: false,
            error: `Skill "${name}" not found. Available: ${available || '(none)'}`,
            durationMs: Date.now() - start,
          };
        }
        return {
          callId: '',
          ok: true,
          output: body,
          durationMs: Date.now() - start,
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
