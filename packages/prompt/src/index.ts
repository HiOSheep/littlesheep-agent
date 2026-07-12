// @littlesheep/prompt — public API

export { CACHE_BOUNDARY_MARKER, splitAtBoundary } from './cache-boundary.js';
export {
  GENERAL_PROFILE,
  CODING_PROFILE,
  ALL_AGENT_PROFILES,
  DEFAULT_AGENT_PROFILE,
  getAgentProfile,
  normalizeAgentProfileId,
  type AgentProfile,
  type AgentProfileId,
} from './profiles.js';
export {
  identitySection,
  coreFlowSection,
  toolingSection,
  safetySection,
  skillsSection,
  workspaceSection,
  dateTimeSection,
  runtimeSection,
  projectContextSection,
  preludeSection,
  outputDirectivesSection,
} from './sections.js';
export {
  buildSystemPrompt,
  resolvePromptConfig,
  assembleSystemPrompt,
  truncateBootstrap,
  applyBootstrapLimits,
  type PromptInput,
  type PromptMode,
  type ResolvedPromptConfig,
  type RuntimeFacts,
} from './builder.js';
