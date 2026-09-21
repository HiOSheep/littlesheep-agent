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
  /** Exact Provider request that authored content when finishReason=stop. */
  modelRequestId?: string;
  error?: string;
  /**
   * The model asked the user for a missing fact. The caller turns this into a
   * clarification request and routes to ASK_USER, which publishes the question
   * as a normal, provider-traceable reply.
   */
  userInputRequest?: import('../../user-input-request.js').UserInputRequest;
}

export interface ToolLoopOptions {
  ctx: RunContext;
  messages: ChatMessage[];
  /**
   * The model-visible tool catalog.
   *
   * One session must show one catalog: the tool names, schemas and order are
   * part of the request prefix, so a catalog that varies per turn invalidates
   * the cached conversation on the turn it changes. Per-turn restriction is an
   * execution-scope decision (`admittedTools`), not a visibility one.
   */
  tools: AgentTool[];
  /**
   * Tools this request may actually invoke. Defaults to `tools`; pass a smaller
   * set to withhold a registered capability for this turn without hiding it
   * from the model. A call outside the set is refused by the Runtime boundary
   * and reported to the model as a denial, never executed.
   */
  admittedTools?: AgentTool[];
  /** Runtime contract text explaining why a withheld tool was refused. */
  withheldToolContract?: string;
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
