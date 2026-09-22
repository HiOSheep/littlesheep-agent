// @littlesheep/harness — user-input-request.ts
//
// The model may ask the user for one missing fact by calling the
// `request_user_input` tool. That call carries no IO: it is a bounded question
// the runtime must turn into a normal, provider-traceable reply and a single
// durable waiting fact. This module owns the validation of that request so the
// tool loop and the stage that handles it agree on one shape.
import { z } from 'zod';

/**
 * Must match `REQUEST_USER_INPUT_TOOL_NAME` in
 * `packages/tools/src/builtin/request_user_input.ts`. The harness does not import
 * the tools package (it receives tools through RunContext), so the name is
 * duplicated deliberately and covered by a test.
 */
export const USER_INPUT_REQUEST_TOOL_NAME = 'request_user_input';

const UserInputRequestSchema = z.object({
  field: z.string().min(1).max(120),
  prompt: z.string().min(1).max(2_000),
  required: z.boolean().default(true),
  options: z.array(z.string().min(1).max(200)).max(6).optional(),
});

export interface UserInputRequest {
  field: string;
  prompt: string;
  required: boolean;
  options?: string[];
}

/** Validate one tool call's input; returns null when it does not fit the contract. */
export function parseUserInputRequest(input: unknown): UserInputRequest | null {
  const parsed = UserInputRequestSchema.safeParse(input);
  if (!parsed.success) return null;
  const { field, prompt, required, options } = parsed.data;
  return {
    field,
    prompt,
    required,
    ...(options && options.length > 0 ? { options } : {}),
  };
}

/**
 * Decide what one tool-call round that names `request_user_input` means.
 *
 * Asking the user is the model's own decision, so the loop carries the question
 * out instead of executing anything. The call must stand alone: a question mixed
 * with other calls would execute work whose answer the user has not given yet, and
 * a malformed question is a protocol error rather than a tool failure.
 */
export function evaluateUserInputRequestRound(
  calls: readonly { name: string; input: unknown }[],
): { kind: 'none' } | { kind: 'invalid'; error: string } | { kind: 'request'; request: UserInputRequest } {
  const questions = calls.filter((call) => call.name === USER_INPUT_REQUEST_TOOL_NAME);
  if (questions.length === 0) return { kind: 'none' };
  if (questions.length !== 1 || calls.length !== 1) {
    return { kind: 'invalid', error: 'a user input request must be one standalone tool call' };
  }
  const request = parseUserInputRequest(questions[0]!.input);
  if (!request) return { kind: 'invalid', error: 'user input request failed Runtime schema validation' };
  return { kind: 'request', request };
}
