// @littlesheep/tools — builtin/request_user_input.ts
//
// Asking the user for a missing detail is a capability the model invokes, not a
// stage the router can fall into: the runtime publishes the question as the
// turn's normal reply and records one bounded waiting fact, so the decision to
// wait stays with the model while the runtime keeps the durable consequence.
import { z } from 'zod';
import type { AgentTool } from '@littlesheep/types';
import { withToolTiming } from '../wrapper.js';

const RequestInput = z.object({
  field: z.string().min(1).describe('Short machine-readable name of the missing fact.'),
  prompt: z.string().min(1).describe('The question to show the user, in the user\'s language.'),
  required: z.boolean().default(true),
  options: z.array(z.string()).max(6).optional()
    .describe('Optional bounded choices; omit to accept a free-form answer.'),
});

export const REQUEST_USER_INPUT_TOOL_NAME = 'request_user_input';

/**
 * Calling this tool performs no IO. It carries the question to the runtime, which
 * publishes it as the user-facing reply and records the waiting checkpoint; the
 * tool result stays in the transcript so the request remains explainable.
 */
export function createRequestUserInputTool(): AgentTool {
  return {
    name: REQUEST_USER_INPUT_TOOL_NAME,
    description:
      'Ask the user for one missing fact you need in order to continue, instead of guessing or failing. '
      + 'The question is published as your reply and the task waits for the answer. '
      + 'Use it only when the answer blocks a useful or safe result: a fact you cannot obtain, a conflict '
      + 'between goals, an irreversible choice, or a permission. When a reasonable default exists — which '
      + 'kind of small game, toy or demo to build, a file name, a layout — pick it, say so in one line and '
      + 'start; the user can redirect after seeing the result. Asking which option the user prefers is not '
      + 'a missing fact.',
    inputSchema: RequestInput,
    execute: withToolTiming(async (input) => {
      const request = RequestInput.parse(input);
      return {
        output: JSON.stringify({ requestedUserInput: true, ...request }),
      };
    }),
  };
}
