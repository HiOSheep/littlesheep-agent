// What the user is actually being asked when recovery gives up.
//
// The escalation used to be one fixed three-way question with the raw reason
// code appended, so the same wording came back whether the run had run out of
// retries, been refused a permission, or lost evidence it could not rebuild. The
// user could not tell those apart, and the model composing the visible message
// had nothing to distinguish them with either.
//
// The Runtime owns three facts here and nothing else: which cause it stopped for,
// what the run already finished, and what would have to change to continue. It
// does not word the message — ASK_USER composes that from a real model call — it
// only stops the model from having to guess.
import type { RunContext } from '@littlesheep/types';

export type RecoveryBlockingCause =
  | 'permission'
  | 'resource'
  | 'evidence'
  | 'side_effect'
  | 'budget'
  | 'aborted'
  | 'execution';

const CAUSE_LABELS: Record<RecoveryBlockingCause, { zh: string; en: string }> = {
  permission: { zh: '权限不足', en: 'missing permission' },
  resource: { zh: '资源缺失', en: 'missing resource' },
  evidence: { zh: '证据不可恢复', en: 'unrecoverable evidence' },
  side_effect: { zh: '副作用未结算', en: 'unsettled side effect' },
  budget: { zh: '恢复预算耗尽', en: 'recovery budget exhausted' },
  aborted: { zh: '执行已中止', en: 'execution stopped' },
  execution: { zh: '执行无法继续', en: 'execution cannot continue' },
};

const REQUIRED_ACTIONS: Record<RecoveryBlockingCause, { zh: string; en: string }> = {
  permission: {
    zh: '授予缺失的权限（或确认这一步不应执行），然后重试；Runtime 不会绕过权限边界',
    en: 'grant the missing permission (or confirm the step should not run), then retry; the Runtime will not work around the permission boundary',
  },
  resource: {
    zh: '提供或恢复缺失的资源（文件、目录或服务），然后重试',
    en: 'provide or restore the missing resource (file, directory or service), then retry',
  },
  evidence: {
    zh: '记录到的证据无法自动修复：请决定保留已完成部分、再尝试一次，还是停止',
    en: 'the recorded evidence cannot be repaired automatically: decide whether to keep the finished part, retry once, or stop',
  },
  side_effect: {
    zh: '先确认那次未结算的副作用实际发生了什么，在此之前不会重新执行',
    en: 'first confirm what the unsettled side effect actually did; nothing will run again before that',
  },
  budget: {
    zh: '给出一次明确的继续机会，或改为保留现状停止；两种选择都不会重放已成功的副作用',
    en: 'give one explicit chance to continue, or stop with the current state; neither replays a succeeded side effect',
  },
  aborted: {
    zh: '取消已经生效，Runtime 不会自行恢复；需要时请重新发起任务',
    en: 'the cancellation already took effect and the Runtime will not resume on its own; start the task again when ready',
  },
  execution: {
    zh: '指出期望的下一步，或改为保留现状停止',
    en: 'state the expected next step, or stop with the current state',
  },
};

/** The cause the Runtime stopped for, derived from the reason code and the stage. */
export function classifyBlockingCause(ctx: RunContext, reasonCode: string): RecoveryBlockingCause {
  if (reasonCode === 'permission_denied' || reasonCode.endsWith('_permission_denied')) return 'permission';
  if (reasonCode === 'unsettled_side_effect') return 'side_effect';
  if (reasonCode === 'run_aborted' || reasonCode.endsWith('_aborted')) return 'aborted';
  if (reasonCode === 'recovery_budget_exhausted') {
    // The budget ran out while retrying something; what it was retrying is the
    // cause the user needs, so the stage that failed decides it.
    return ctx.lastError?.stage === 'verify' ? 'evidence' : 'budget';
  }
  if (reasonCode.endsWith('_not_found')) return 'resource';
  if (ctx.lastError?.stage === 'verify') return 'evidence';
  return 'execution';
}

export function blockingCauseLabel(cause: RecoveryBlockingCause, chinese: boolean): string {
  return chinese ? CAUSE_LABELS[cause].zh : CAUSE_LABELS[cause].en;
}

export function requiredActionFor(cause: RecoveryBlockingCause, chinese: boolean): string {
  return chinese ? REQUIRED_ACTIONS[cause].zh : REQUIRED_ACTIONS[cause].en;
}

/**
 * What this run already finished, as Runtime facts.
 *
 * Bounded and redacted by construction: counts and states only, never file
 * contents, paths or tool output.
 */
export function completedWorkSummary(ctx: RunContext, chinese: boolean): string {
  const effects = ctx.sideEffects ?? [];
  const succeeded = effects.filter((effect) => effect.status === 'succeeded').length;
  const failed = effects.filter((effect) => effect.status === 'failed').length;
  const unsettled = effects.filter((effect) => (
    effect.status === 'planned' || effect.status === 'in_progress' || effect.status === 'unknown'
  )).length;
  const invocations = ctx.toolInvocations ?? [];
  const succeededCalls = invocations.filter((invocation) => invocation.status === 'succeeded').length;
  const parts: string[] = [];
  if (chinese) {
    parts.push(invocations.length > 0
      ? `本次运行记录了 ${invocations.length} 次工具调用，其中 ${succeededCalls} 次成功`
      : '本次运行没有记录到工具调用');
    if (effects.length > 0) {
      parts.push(`副作用：${succeeded} 次已成功、${failed} 次已失败、${unsettled} 次未结算`);
    }
    if (ctx.reply?.trim()) parts.push('已有一份未发布的回答草稿');
  } else {
    parts.push(invocations.length > 0
      ? `this run recorded ${invocations.length} tool calls, ${succeededCalls} of them succeeded`
      : 'this run recorded no tool calls');
    if (effects.length > 0) {
      parts.push(`side effects: ${succeeded} succeeded, ${failed} failed, ${unsettled} unsettled`);
    }
    if (ctx.reply?.trim()) parts.push('an unpublished draft answer exists');
  }
  return parts.join(chinese ? '；' : '; ');
}
