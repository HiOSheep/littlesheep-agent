﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿// @littlesheep/tools — public API

export { ToolRegistry } from './registry.js';
export { checkApproval, interactiveApprove, DEFAULT_APPROVAL, type ApprovalConfig } from './approval.js';
export { sanitizeOutput, truncateText, stripImages, isBinary, binaryPreview, DEFAULT_SANITIZE, type SanitizeOptions } from './sanitize.js';
export { withToolTiming, type ToolHandler } from './wrapper.js';
export { parallelFilePolicy } from './execution-policy.js';
export {
  createFileObservationTable,
  createInMemoryFileObservationPort,
  createPathMutexTable,
  hashFileBytes,
  observationKeyFor,
  observationSnapshot,
  type FileObservationTableOptions,
  type ObservationKeyResult,
  type PathMutexTable,
} from './file-observation.js';
export {
  ToolExecutionService,
  DEFAULT_TOOL_TIMEOUT_MS,
  DEFAULT_MAX_REPEATED_TOOL_CALLS,
  DEFAULT_MAX_TOOL_INVOCATION_RECORDS,
  type ToolInvocationRequest,
  type ToolExecutionLifecycle,
  type ToolExecutionLifecycleContext,
  type ToolExecutionLifecycleResult,
  type ToolExecutionServiceOptions,
} from './tool-execution-service.js';
export {
  buildToolExecutionWaves,
  executeToolWaves,
  toolResourceAccessCovered,
  toolResourcesConflict,
  type ScheduledToolExecution,
} from './tool-execution-scheduler.js';
export {
  durableToolResult,
  projectToolInput,
  resolveToolExecutionPolicy,
} from './tool-execution-result.js';

export { readTool } from './builtin/read.js';
export { writeTool } from './builtin/write.js';
export { editTool } from './builtin/edit.js';
export {
  execTool,
  createExecTool,
  describeExecutionShell,
  type ExecToolOptions,
  type ExecutionShellDescriptor,
} from './builtin/exec.js';
export { grepTool } from './builtin/grep.js';
export { globTool } from './builtin/glob.js';
export { documentReadTool } from './builtin/document-read.js';
export { documentCreateTool } from './builtin/document-create.js';
export { createRequestUserInputTool, REQUEST_USER_INPUT_TOOL_NAME } from './builtin/request_user_input.js';
export { createSessionStatusTool } from './builtin/session_status.js';
export { webSearchTool } from './builtin/web_search.js';
export { webFetchTool } from './builtin/web_fetch.js';

import type { AgentTool } from '@littlesheep/types';
import { ToolRegistry } from './registry.js';
import { readTool } from './builtin/read.js';
import { writeTool } from './builtin/write.js';
import { editTool } from './builtin/edit.js';
import { execTool } from './builtin/exec.js';
import { grepTool } from './builtin/grep.js';
import { globTool } from './builtin/glob.js';
import { documentReadTool } from './builtin/document-read.js';
import { documentCreateTool } from './builtin/document-create.js';
import { webSearchTool } from './builtin/web_search.js';
import { webFetchTool } from './builtin/web_fetch.js';

/** Register core built-ins only. Memory tools are supplied by the index-first runtime. */
export function registerBuiltinTools(registry: ToolRegistry, extra: AgentTool[] = []): void {
  registry.register(readTool);
  registry.register(writeTool);
  registry.register(editTool);
  registry.register(execTool);
  registry.register(grepTool);
  registry.register(globTool);
  registry.register(documentReadTool);
  registry.register(documentCreateTool);
  registry.register(webSearchTool);
  registry.register(webFetchTool);
  for (const tool of extra) {
    registry.register(tool);
  }
}
