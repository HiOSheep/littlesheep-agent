import type { RunContext } from '@littlesheep/types';
import { textOf } from '../_shared.js';

export function hasReusableEvolutionSignal(ctx: RunContext): boolean {
  if (ctx.verificationHistory?.at(-1)?.verdict !== 'pass') return false;
  const inbound = textOf(ctx.inbound);
  if (/(?:记住|以后|始终|偏好|习惯|规则|约定|remember|always|prefer|preference|convention)/iu.test(inbound)) {
    return true;
  }
  if (ctx.taskBook?.complexity === 'complex' || ctx.taskBook?.complexity === 'standard') return true;
  if ((ctx.recoveryAttempts ?? 0) > 0 || (ctx.replanAttempts ?? 0) > 0) return true;
  const durableTools = new Set(['write', 'edit', 'exec', 'create_skill']);
  return ctx.produced.some((message) => message.content.some((block) => (
    block.type === 'tool_calls' && block.calls.some((call) => durableTools.has(call.name))
  )));
}
