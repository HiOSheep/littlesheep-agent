// Projects real model request work without exposing Harness control-state names.
import type {
  LlmCallPurpose,
  ModelRequestSnapshot,
  ObservableActivityStatus,
  RunContext,
} from '@littlesheep/types';
import type { ChatRequest } from '@littlesheep/llm';

interface ModelActivityState {
  snapshot: ModelRequestSnapshot;
  startedAtMs: number;
  settled: boolean;
}

const requestActivities = new WeakMap<ChatRequest, ModelActivityState>();

const ZH_ACTIVITY: Record<LlmCallPurpose, string> = {
  classify: '模型正在判断如何处理请求',
  decide: '模型正在分析目标并生成执行方案',
  decide_explicit_tool: '模型正在分析目标并准备指定操作',
  execute_tool_loop: '模型正在根据当前证据生成下一步操作',
  execute_final_reply: '模型正在组织最终回复',
  recover: '模型正在分析失败原因',
  verify: '模型正在检查执行证据',
  evolve: '模型正在提炼可复用经验',
  capture: '模型正在整理运行记录',
  reply: '模型正在生成回复',
  capability_reply: '模型正在根据能力事实生成回复',
  ask_user: '模型正在组织需要确认的问题',
  finalize: '模型正在组织最终结果',
  session_compaction: '模型正在压缩会话上下文',
};

const EN_ACTIVITY: Record<LlmCallPurpose, string> = {
  classify: 'The model is deciding how to handle the request',
  decide: 'The model is analyzing the goal and preparing an execution plan',
  decide_explicit_tool: 'The model is analyzing the goal and preparing the requested action',
  execute_tool_loop: 'The model is using current evidence to prepare the next action',
  execute_final_reply: 'The model is organizing the final reply',
  recover: 'The model is analyzing the failure',
  verify: 'The model is checking the execution evidence',
  evolve: 'The model is extracting reusable lessons',
  capture: 'The model is organizing the run record',
  reply: 'The model is generating a reply',
  capability_reply: 'The model is generating a reply from capability facts',
  ask_user: 'The model is preparing a clarification question',
  finalize: 'The model is organizing the final result',
  session_compaction: 'The model is compacting the conversation context',
};

export function emitModelRequestActivity(
  ctx: RunContext,
  snapshot: ModelRequestSnapshot,
  status: ObservableActivityStatus,
  durationMs?: number,
): void {
  const purpose = snapshot.callContract?.purpose;
  if (!purpose) return;
  const chinese = /[\u3400-\u9fff]/u.test(inboundText(ctx));
  const running = (chinese ? ZH_ACTIVITY : EN_ACTIVITY)[purpose];
  const summary = status === 'running'
    ? running
    : status === 'done'
      ? (chinese ? running.replace('正在', '已完成：') : running.replace(' is ', ' has finished '))
      : status === 'aborted'
        ? (chinese ? '模型请求已取消' : 'The model request was aborted')
        : (chinese ? '模型请求未能完成' : 'The model request failed');
  try {
    ctx.onToolEvent?.({
      type: 'model_activity',
      visibility: 'progress',
      phaseId: `model-request:${snapshot.id}`,
      requestId: snapshot.id,
      activityKind: 'model_request',
      activityStatus: status,
      summary,
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  } catch (error) {
    ctx.toolContext.log?.('warn', `model activity delivery failed: ${(error as Error).message}`);
  }
}

export function startModelRequestActivity(
  ctx: RunContext,
  request: ChatRequest,
  snapshot: ModelRequestSnapshot,
): void {
  if (requestActivities.has(request)) return;
  requestActivities.set(request, { snapshot, startedAtMs: Date.now(), settled: false });
  emitModelRequestActivity(ctx, snapshot, 'running');
}

export function settleModelRequestActivity(
  ctx: RunContext,
  request: ChatRequest,
  status: 'done' | 'failed' | 'aborted',
): void {
  const state = requestActivities.get(request);
  if (!state || state.settled) return;
  state.settled = true;
  emitModelRequestActivity(ctx, state.snapshot, status, Math.max(0, Date.now() - state.startedAtMs));
}

function inboundText(ctx: RunContext): string {
  return ctx.inbound.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
