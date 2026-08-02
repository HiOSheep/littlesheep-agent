﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿// @littlesheep/tools — public API

export { ToolRegistry } from './registry.js';
export { checkApproval, interactiveApprove, DEFAULT_APPROVAL, type ApprovalConfig } from './approval.js';
export { sanitizeOutput, truncateText, stripImages, isBinary, binaryPreview, DEFAULT_SANITIZE, type SanitizeOptions } from './sanitize.js';
export { withToolTiming, type ToolHandler } from './wrapper.js';
export { parallelFilePolicy } from './execution-policy.js';
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
export { resolveToolExecutionPolicy } from './tool-execution-result.js';

export { readTool } from './builtin/read.js';
export { writeTool } from './builtin/write.js';
export { editTool } from './builtin/edit.js';
export { execTool, createExecTool, type ExecToolOptions } from './builtin/exec.js';
export { grepTool } from './builtin/grep.js';
export { globTool } from './builtin/glob.js';
/** @deprecated Legacy library adapter. The LS runtime does not register this agent tool. */
export { createMemorySearchTool } from './builtin/memory_search.js';
/** @deprecated Legacy library adapter. The LS runtime does not register this agent tool. */
export { createMemoryDeepSearchTool } from './builtin/memory_deep_search.js';
export { createSessionStatusTool } from './builtin/session_status.js';

import type { AgentTool } from '@littlesheep/types';
import { ToolRegistry } from './registry.js';
import { readTool } from './builtin/read.js';
import { writeTool } from './builtin/write.js';
import { editTool } from './builtin/edit.js';
import { execTool } from './builtin/exec.js';
import { grepTool } from './builtin/grep.js';
import { globTool } from './builtin/glob.js';

/** Register core built-ins only. Memory tools are supplied by the index-first runtime. */
export function registerBuiltinTools(registry: ToolRegistry, extra: AgentTool[] = []): void {
  registry.register(readTool);
  registry.register(writeTool);
  registry.register(editTool);
  registry.register(execTool);
  registry.register(grepTool);
  registry.register(globTool);
  for (const tool of extra) {
    registry.register(tool);
  }
}
