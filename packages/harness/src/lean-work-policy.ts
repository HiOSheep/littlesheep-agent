import type { RunContext } from '@littlesheep/types';
import { assessRetrievalIntent } from './retrieval-intent.js';

const LEAN_SINGLE_GOAL = /(?:写一个|写个|做一个|做个|再做|制作一个|制作个|创建一个|创建个|生成一个|生成个|修复这个|修改这个|更新这个)|\b(?:create|make|build|write|fix|update)\s+(?:a|an|this)\b/iu;
const COMPLEX_SCOPE = /(?:多阶段|多步骤|完整系统|整个项目|全项目|架构|迁移|重构|批量|并行|分别|多个|所有文件|端到端)|\b(?:multi[- ]stage|multi[- ]step|architecture|migrate|refactor|batch|parallel|entire project|all files|end-to-end)\b/iu;

/** Conservative next-Harness gate for one self-contained goal handled by the tool loop itself. */
export function canUseLeanWorkLoop(ctx: RunContext): boolean {
  if (ctx.streamModelTranscript !== true
    || ctx.classification?.activity !== 'execute'
    || ctx.classification.source !== 'rules'
    || ctx.classification.reason !== 'action verb'
    || ctx.taskBook
    || ctx.partialReplanRequest
    || ctx.verifyFeedback
    || ctx.clarificationResponse
    || ctx.resumedFromCheckpointId
    || (ctx.deferredRuntimeEvents?.length ?? 0) > 0) return false;
  const text = inboundText(ctx);
  if (!text || text.length > 2_000 || COMPLEX_SCOPE.test(text)) return false;
  const retrieval = assessRetrievalIntent(text);
  return retrieval.intent === 'none' && LEAN_SINGLE_GOAL.test(text);
}

function inboundText(ctx: RunContext): string {
  return ctx.inbound.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}
