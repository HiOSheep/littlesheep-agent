import type { BrandingConfig } from '@littlesheep/branding';
import type { Config } from '@littlesheep/config';
import type { ChatMessage, ChatResponse, LlmClient } from '@littlesheep/llm';
import type { SystemPromptBundle } from '@littlesheep/prompt';
import type { AgentTool, RunContext, ToolResult } from '@littlesheep/types';
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
}
