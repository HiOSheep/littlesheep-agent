// @littlesheep/classifier — index.ts
// Deterministic rules only. Activity routing no longer asks a model: an
// unmatched request goes to the single main loop, which decides whether to
// answer or call a tool.

export {
  classifyByRules,
  extractExplicitToolInstructionNames,
  isMemoryRecallRequest,
  listRules,
} from './rules.js';
export type { Rule } from './rules.js';
