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
 * Asking the user is the model's own decision, so the question is carried out of
 * the loop instead of being executed. Two shapes can go wrong:
 *
 * - A *malformed* question, or two questions in one round, is a protocol error:
 *   the Runtime would have to choose which question to publish, and a question it
 *   cannot read is not a question.
 * - A question mixed with other calls is **not** an error in the question: the
 *   calls beside it are refused (work whose answer is still pending must not
 *   run), and the question is carried out as usual. Making the whole turn fail
 *   threw the model's own wording away and spent recovery attempts on a round
 *   that only had to drop the extra calls.
 */
export function evaluateUserInputRequestRound(
  calls: readonly { name: string; input: unknown }[],
): (
  | { kind: 'none' }
  | { kind: 'invalid'; error: string }
  | { kind: 'request'; request: UserInputRequest }
  | { kind: 'mixed'; request: UserInputRequest }
) {
  const questions = calls.filter((call) => call.name === USER_INPUT_REQUEST_TOOL_NAME);
  if (questions.length === 0) return { kind: 'none' };
  if (questions.length > 1) {
    return { kind: 'invalid', error: 'a user input request must be one standalone tool call' };
  }
  const request = parseUserInputRequest(questions[0]!.input);
  if (!request) return { kind: 'invalid', error: 'user input request failed Runtime schema validation' };
  return calls.length === 1 ? { kind: 'request', request } : { kind: 'mixed', request };
}

/**
 * Why a call that shared its round with a question was not run.
 *
 * The model sees this as the call's tool result, so it can tell "the Runtime
 * refused this" from "this ran", and re-issue it after the answer if it is still
 * wanted.
 */
export const USER_INPUT_REQUEST_SIBLING_REFUSAL =
  'Runtime: this call was not run because the same round asked the user a question, and work that may depend on the answer must wait for it. Ask the question on its own, or re-issue this call after the answer arrives.';
