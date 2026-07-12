// @littlesheep/skills — public API
// Skill loader + use_skill/create_skill tools. The gateway builds a
// SkillLoader once at startup and binds it to both tools registered in the
// ToolRegistry. create_skill enables self-evolution: the agent can write
// new skills and they become available immediately via hot-reload.

export {
  loadSkillIndex,
  loadSkillBody,
  createSkillLoader,
  writeSkillFile,
  findBuiltinSkillsDir,
  parseSkillFile,
  type SkillIndex,
  type SkillIndexEntry,
  type SkillLoader,
  type LoadSkillIndexOptions,
  type ParsedSkillFile,
} from './loader.js';

export { createUseSkillTool } from './use_skill.js';
export { createCreateSkillTool, type CreateSkillToolDeps } from './create-skill.js';
