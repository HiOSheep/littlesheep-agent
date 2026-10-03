// Shared, exhaustive discriminator for the public durable event union.
import type { DurableHarnessEvent } from '@littlesheep/types';
const EVENT_TYPES: Record<DurableHarnessEvent['type'], true> = {
  run_accepted: true, user_input_appended: true,
  capability_snapshot_read: true, capability_probe_settled: true,
  stage_transition_recorded: true, route_decided: true,
  model_request_started: true, model_response_received: true,
  provider_usage_recorded: true, model_request_settled: true,
  tool_call_proposed: true, effect_intent_created: true, effect_settled: true,
  verification_recorded: true, checkpoint_written: true,
  final_reply_proposed: true, final_reply_settled: true, runtime_status_settled: true,
  run_failed: true, run_interrupted: true, run_completed: true,
};
export function isEventType(value: unknown): value is DurableHarnessEvent['type'] {
  return typeof value === 'string' && Object.hasOwn(EVENT_TYPES, value);
}
