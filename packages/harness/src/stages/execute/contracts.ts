import type { BrandingConfig } from '@littlesheep/branding';
import type { Config } from '@littlesheep/config';
import type { ChatMessage, ChatResponse, LlmClient } from '@littlesheep/llm';
import type { SystemPromptBundle } from '@littlesheep/prompt';
import type {
  AgentTool,
  Message,
  RunContext,
  TaskStepSideEffect,
  ToolResourceAccess,
  ToolResult,
} from '@littlesheep/types';
import type { InsertedContextMessage } from '../../context-candidates.js';

export interface ExecuteStageDeps {
  llm: LlmClient;
  model: string;
  config: Config;
  branding: BrandingConfig;
}

export interface ExecuteSanitizeOptions {
  maxOutputChars: number;
  stripImages: boolean;
}

export interface ToolLoopResult {
  ok: boolean;
  content: string;
  toolResults: ToolResult[];
  iterations: number;
  usage?: ChatResponse['usage'];
  error?: string;
}

export interface ToolLoopOptions {
  ctx: RunContext;
  messages: ChatMessage[];
  tools: AgentTool[];
  sanitizeOpts: ExecuteSanitizeOptions;
  stepId?: string;
  systemSegments?: SystemPromptBundle['segments'];
  insertedBeforePrimary?: InsertedContextMessage[];
  /** Exact history represented in messages; compact self-contained tasks use none. */
  history?: Message[];
  /** Branch-local cancellation; the run signal remains its parent. */
  signal?: AbortSignal;
  /** Branch-local message sink merged into the run in stable TaskBook order. */
  produced?: RunContext['produced'];
  /** Runtime-approved resource envelope for a parallel TaskBook step. */
  parallelStep?: {
    sideEffect: TaskStepSideEffect;
    resources: readonly ToolResourceAccess[];
  };
  /** Optional per-batch cap; parallel steps use one tool call per branch. */
  maxParallelTools?: number;
}
