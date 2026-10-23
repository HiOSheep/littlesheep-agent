// One authoritative list of ToolStreamEvent names carried by the run SSE
// stream. The exhaustive Record compile-fails when a ToolStreamEvent variant
// is added without updating the renderer, so a new event can no longer be
// silently dropped by the client's long event-name chain.
import type { ToolStreamEvent } from '@littlesheep/types'

const TOOL_STREAM_EVENT_NAMES: Record<ToolStreamEvent['type'], true> = {
  tool_start: true,
  tool_end: true,
  tool_preparing: true,
  task_book: true,
  reasoning: true,
  step_start: true,
  step_done: true,
  step_failed: true,
  step_skipped: true,
  verification_start: true,
  verification: true,
  final_delta: true,
  model_reasoning: true,
  model_activity: true,
  model_text: true,
  runtime_activity: true,
  system_prompt: true,
  capability_snapshot: true,
  capability_probe: true,
}

export const TOOL_STREAM_EVENT_NAME_LIST = Object.freeze(
  Object.keys(TOOL_STREAM_EVENT_NAMES) as ToolStreamEvent['type'][],
)

export function isToolStreamEventName(name: string): name is ToolStreamEvent['type'] {
  return Object.prototype.hasOwnProperty.call(TOOL_STREAM_EVENT_NAMES, name)
}
