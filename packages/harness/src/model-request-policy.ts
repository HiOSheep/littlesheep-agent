// Model request policy keeps Provider-specific direct-output controls out of the observability facade.
import type { ChatRequest } from '@littlesheep/llm';
import type { RunContext } from '@littlesheep/types';

/**
 * Compatibility facade for existing call sites. Reasoning is applied once by
 * prepareModelRequest from the immutable resolved run configuration.
 */
export function preferDirectModelOutput(
  _ctx: RunContext,
  request: ChatRequest,
  _options: { force?: boolean } = {},
): ChatRequest {
  return request;
}
