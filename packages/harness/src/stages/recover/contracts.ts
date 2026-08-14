import type { LlmClient } from '@littlesheep/llm';

export interface RecoverStageDeps {
  llm: LlmClient;
  model: string;
}

export interface DecodedRecovery {
  action?: string;
  revisedPlan?: Array<{ description?: string; tools?: unknown; requiresApproval?: boolean }>;
  reason?: string;
  userMessage?: string;
}

export const RECOVER_SYSTEM_PROMPT = `You are the RECOVER stage of a hard-control-flow agent.
A prior stage failed. Decide how to proceed.

Return ONLY a JSON object, no markdown:
{"action":"retry"|"escalate"|"abort","revisedPlan":[{"description":"...","tools":["..."],"requiresApproval":false}],"reason":"short explanation","userMessage":"complete user-facing question when action is escalate"}

The reason may be shown to the user. Write it in the user's language, follow the active voice, keep it concise and do not expose private chain-of-thought.

Actions:
- "retry": try the failing stage again. Optionally provide a revisedPlan (replaces the current plan).
- "escalate": hand control back to the user. Include userMessage as one complete, actionable question in the user's language.
- "abort": terminate the run entirely. Use only for unrecoverable failures.

If a failure says a tool is registered for the run but unavailable in the current TaskBook step, the tool exists. When it is appropriate for the user's task, retry with a revisedPlan that explicitly lists that tool; do not report it as missing or uninstalled.

A JSON/structured-output decode failure is an internal formatting failure. It is not evidence that the model, provider, or LittleSheep's overall reply capability is damaged. Never abort or make a broad capability claim solely because one stage could not decode structured output.`;
