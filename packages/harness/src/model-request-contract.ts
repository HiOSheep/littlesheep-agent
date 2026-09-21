// Enforce an outbound request against its resolved call contract, and apply the
// run's reasoning preference to it.
//
// Both checks sit immediately in front of the Provider call: the contract decides
// what a purpose may spend and which tools it may name, and the reasoning
// preference decides the sampling shape. Keeping them together makes the single
// place a request can still be rejected or rewritten before it is recorded
// explicit, and keeps the request-observation facade from growing another
// responsibility.
import type { LlmCallContract, RunContext } from '@littlesheep/types';
import type { ChatRequest } from '@littlesheep/llm';
import { resolveProviderReasoningRequest } from '@littlesheep/config';
import { LlmCallContractViolationError } from './llm-call-contracts/registry.js';

/** Reject a request the resolved contract forbids, before it reaches the Provider. */
export function validateModelRequest(contract: LlmCallContract, request: ChatRequest): void {
  if (contract.modelCall === 'forbidden') {
    throw new LlmCallContractViolationError(
      'forbidden_model_call',
      'this purpose must be completed without another model request.',
      contract.id,
    );
  }
  if (request.max_tokens !== undefined && (
    !Number.isFinite(request.max_tokens)
    || request.max_tokens < 0
    || request.max_tokens > contract.budget.maxOutputTokens
  )) {
    throw new LlmCallContractViolationError(
      'output_budget_exceeded',
      `requested max_tokens ${request.max_tokens} exceeds budget ${contract.budget.maxOutputTokens}.`,
      contract.id,
    );
  }

  const requestedToolNames = request.tools?.map((tool) => tool.function.name) ?? [];
  if (contract.toolPolicy.mode === 'none' && requestedToolNames.length > 0) {
    throw new LlmCallContractViolationError(
      'tool_forbidden',
      `this purpose forbids tools but request included: ${requestedToolNames.join(', ')}.`,
      contract.id,
    );
  }
  const allowedToolNames = new Set(contract.toolPolicy.allowedToolNames);
  const disallowed = requestedToolNames.filter((name) => !allowedToolNames.has(name));
  const namedChoice = typeof request.tool_choice === 'object'
    ? request.tool_choice.function.name
    : undefined;
  if (namedChoice && !allowedToolNames.has(namedChoice)) disallowed.push(namedChoice);
  if (disallowed.length > 0) {
    throw new LlmCallContractViolationError(
      'tool_not_allowed',
      `request referenced tools outside the resolved scope: ${[...new Set(disallowed)].join(', ')}.`,
      contract.id,
    );
  }
}

/** Apply the run-wide reasoning preference unless the request set its own. */
export function applyResolvedReasoning(ctx: RunContext, request: ChatRequest): ChatRequest {
  const resolved = ctx.resolvedRunConfig;
  if (!resolved) return request;

  // Explicit per-request controls are used only by bounded recovery paths and
  // must not be overwritten by the run-wide reasoning preference.
  if (request.reasoning_effort !== undefined || request.thinking !== undefined) return request;
  const options = resolveProviderReasoningRequest(
    resolved.provider,
    resolved.model,
    resolved.reasoning,
  );
  if (!options.reasoningEffort && !options.thinking) return request;

  const stripTemperature = resolved.provider === 'deepseek'
    || (resolved.provider === 'openai' && options.reasoningEffort !== undefined);
  return {
    ...request,
    temperature: stripTemperature ? undefined : request.temperature,
    reasoning_effort: options.reasoningEffort,
    thinking: options.thinking
      ? {
          type: options.thinking.type,
          clear_thinking: options.thinking.clearThinking,
        }
      : undefined,
  };
}
