// @littlesheep/runner — public API
//
// Shared agent runner used by:
//   - Electron APP (local conversations, origin='app')
//   - Optional channel plugins (channel-routed conversations, origin='channel')
//   - CLI (single-shot + REPL, origin='cli')
//
// The runner is the core execution entry point; optional extensions call it
// through their declared contribution contracts.

export {
  createRunner,
  type AgentRunner,
  type RunnerResult,
  type CreateRunnerOptions,
  type RunInput,
  type RunOrigin,
} from './runner.js';

export { resolveRunConfig, type ResolveRunConfigOptions } from './run-config.js';

export {
  buildInfrastructure,
  resolveLlm,
  type Infrastructure,
  type RunnerState,
  type BuildInfrastructureOptions,
  type LogFn,
} from './infra.js';

export {
  ExecutionLogStore,
  type ExecutionLog,
  type ExecutionLogInput,
  type ToolCallRecord,
  type StageTraceEntry,
  type ExecutionLogStoreOptions,
} from './execution-log.js';
