import type { RunContext, StageName } from '@littlesheep/types';

type ProgressStatus = 'running' | 'done' | 'failed';

interface StageCopy {
  running: string;
  done: string;
}

const ZH_STAGE_COPY: Record<StageName, StageCopy> = {
  enter: { running: '正在准备本轮任务上下文', done: '已准备本轮任务上下文' },
  classify: { running: '正在判断应直接回答、执行任务还是请求补充信息', done: '已确定本轮处理路径' },
  reply: { running: '正在组织直接回答', done: '已生成直接回答' },
  ask_user: { running: '正在整理需要确认的信息', done: '已形成明确的确认问题' },
  decide: { running: '正在校准目标、范围和验收标准', done: '已形成执行路径和验收标准' },
  execute: { running: '正在按已确认的步骤推进任务', done: '已完成计划内执行' },
  recover: { running: '正在定位失败原因并调整执行路径', done: '已完成恢复判断' },
  verify: { running: '正在根据目标、证据和验收标准检查结果', done: '已完成结果验证' },
  evolve: { running: '正在提炼本轮可复用经验', done: '已完成经验整理' },
  capture: { running: '正在记录本轮任务的关键证据', done: '已完成运行记录' },
  finalize: { running: '正在保存并完成本轮回答', done: '已完成本轮回答' },
};

const EN_STAGE_COPY: Record<StageName, StageCopy> = {
  enter: { running: 'Preparing the context for this run', done: 'Prepared the context for this run' },
  classify: { running: 'Choosing whether to answer, execute, or request clarification', done: 'Selected the route for this run' },
  reply: { running: 'Composing the direct answer', done: 'Generated the direct answer' },
  ask_user: { running: 'Preparing the information request', done: 'Prepared a specific clarification question' },
  decide: { running: 'Calibrating the goal, scope, and success criteria', done: 'Prepared the execution path and success criteria' },
  execute: { running: 'Working through the confirmed steps', done: 'Completed the planned execution' },
  recover: { running: 'Diagnosing the failure and adjusting the execution path', done: 'Completed the recovery decision' },
  verify: { running: 'Checking the result against the goal, evidence, and success criteria', done: 'Completed result verification' },
  evolve: { running: 'Extracting reusable lessons from this run', done: 'Completed experience refinement' },
  capture: { running: 'Recording the key evidence from this run', done: 'Completed the run record' },
  finalize: { running: 'Saving and completing the answer', done: 'Completed this answer' },
};

export function emitPublicReasoningProgress(
  ctx: RunContext,
  stage: StageName,
  phaseId: string,
  status: ProgressStatus,
  durationMs?: number,
): void {
  const chinese = /[\u3400-\u9fff]/u.test(inboundText(ctx));
  const copy = (chinese ? ZH_STAGE_COPY : EN_STAGE_COPY)[stage];
  const summary = status === 'failed'
    ? (chinese ? `${copy.running}时未能完成，正在按运行时恢复策略处理` : `The ${stage} phase did not complete; Runtime recovery policy is taking over`)
    : copy[status];
  try {
    ctx.onToolEvent?.({
      type: 'reasoning',
      phaseId,
      stage,
      reasoningStatus: status,
      summary,
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  } catch (error) {
    ctx.toolContext.log?.('warn', `public reasoning progress delivery failed: ${(error as Error).message}`);
  }
}

function inboundText(ctx: RunContext): string {
  return ctx.inbound.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
