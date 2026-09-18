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
