// @littlesheep/prompt — public API

export { CACHE_BOUNDARY_MARKER } from './cache-boundary.js';
export {
  formatElapsedMilliseconds,
  formatRuntimeClock,
  resolveRuntimeTimeZone,
  type RuntimeClockValue,
  type RuntimeTimeFormat,
} from './runtime-time.js';
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
  capabilitiesSection,
  safetySection,
  skillsSection,
  memoryTreeSection,
  workspaceSection,
  dateTimeSection,
  runtimeSection,
  projectContextSection,
  preludeSection,
  sessionSummarySection,
  outputDirectivesSection,
} from './sections.js';
export {
  buildSystemPrompt,
  buildSystemPromptBundle,
  resolvePromptConfig,
  assembleSystemPrompt,
  assembleSystemPromptBundle,
  truncateBootstrap,
  applyBootstrapLimits,
  type PromptInput,
  type PromptContextSegment,
  type PromptMode,
  type ResolvedPromptConfig,
  type RuntimeFacts,
  type SystemPromptBundle,
} from './builder.js';
