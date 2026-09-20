// @littlesheep/skills — public API
// Skill loader + use_skill. The gateway builds a SkillLoader once at startup
// and binds it to the loader tool registered in the ToolRegistry. Automatic
// skill creation was removed with the lean plan: skills are authored by the
// user (or a skill source), never by a run.

export {
  loadSkillIndex,
  loadSkillBody,
  createSkillLoader,
  writeSkillFile,
  findBuiltinSkillsDir,
  parseSkillFile,
  type SkillIndex,
  type SkillIndexEntry,
  type SkillAvailability,
  type SkillLoader,
  type SkillSourceDefinition,
  type SkillSourceKind,
  type LoadSkillIndexOptions,
  type ParsedSkillFile,
} from './loader.js';

export { createUseSkillTool } from './use_skill.js';
