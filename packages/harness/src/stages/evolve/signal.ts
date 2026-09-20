import type { RunContext } from '@littlesheep/types';
import { textOf } from '../_shared.js';
import { hasCleanVerification } from '../../verification-state.js';

export function hasReusableEvolutionSignal(ctx: RunContext): boolean {
  if (!hasCleanVerification(ctx)) return false;
  const inbound = textOf(ctx.inbound);
  if (/(?:记住|以后|始终|偏好|习惯|规则|约定|remember|always|prefer|preference|convention)/iu.test(inbound)) {
    return true;
  }
  if (ctx.taskBook?.complexity === 'complex' || ctx.taskBook?.complexity === 'standard') return true;
  if ((ctx.recoveryAttempts ?? 0) > 0 || (ctx.replanAttempts ?? 0) > 0) return true;
  const durableTools = new Set(['write', 'edit', 'exec']);
  return ctx.produced.some((message) => message.content.some((block) => (
    block.type === 'tool_calls' && block.calls.some((call) => durableTools.has(call.name))
  )));
}

/** Explicit user-directed memory/Skill maintenance remains immediate under compaction-only learning. */
export function hasExplicitEvolutionRequest(ctx: RunContext): boolean {
  if (!hasCleanVerification(ctx)) return false;
  const inbound = textOf(ctx.inbound);
  return /(?:记住|记下|牢记|保存.{0,12}(?:偏好|规则|约定|事实)|纠正.{0,12}(?:记忆|事实)|修改.{0,12}(?:记忆|偏好)|忘记|撤销.{0,12}(?:记忆|偏好)|创建.{0,12}(?:技能|skill))|\b(?:remember|memorize|correct|revise|forget|remove)\b.{0,48}\b(?:memory|preference|fact|rule|convention)\b|\bcreate\b.{0,20}\bskill\b/iu.test(inbound);
}
