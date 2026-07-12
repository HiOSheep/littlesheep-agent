// @littlesheep/runner — public API
//
// Shared agent runner used by:
//   - Electron APP (local conversations, origin='app')
//   - Channel gateway service (channel-routed conversations, origin='channel')
//   - CLI (single-shot + REPL, origin='cli')
//
// Replaces the former @littlesheep/gateway runOnce entry point.

export {
  createRunner,
  type AgentRunner,
  type RunnerResult,
  type CreateRunnerOptions,
  type RunInput,
  type RunOrigin,
} from './runner.js';

export {
  buildInfrastructure,
  resolveLlm,
  type Infrastructure,
  type GatewayState,
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
