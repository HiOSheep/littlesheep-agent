// Builds immutable source records only from information visible in the conversation area.

import type { Message, RunContext, ToolCall, ToolResult } from '@littlesheep/types';
import type { MemoryConversationSourceInput } from '@littlesheep/memory-tree';

const MAX_SOURCE_RECORDS_PER_RUN = 128;

export function collectConversationSourceRecords(ctx: RunContext): MemoryConversationSourceInput[] {
  const records: MemoryConversationSourceInput[] = [messageSource(ctx.inbound, ctx)];
  const calls = new Map<string, { call: ToolCall; occurredAt: string }>();
  const results = new Map<string, { result: ToolResult; occurredAt: string }>();

  for (const message of ctx.produced) {
    for (const block of message.content) {
      if (block.type === 'tool_calls') {
        for (const call of block.calls) calls.set(call.id, { call, occurredAt: message.timestamp });
      } else if (block.type === 'tool_result') {
        results.set(block.result.callId, { result: block.result, occurredAt: message.timestamp });
      }
    }
  }

  if (ctx.reply?.trim()) {
    records.push({
      id: sourceId(ctx.runId, 'assistant-reply'),
      kind: 'assistant-reply',
      sessionId: String(ctx.sessionId),
      runId: ctx.runId,
      occurredAt: ctx.taskExecution?.endedAt ?? ctx.startedAt,
      payload: { text: ctx.reply, stage: 'finalize' },
    });
  }

  for (const [callId, entry] of calls) {
    records.push({
      id: sourceId(ctx.runId, 'tool-call', callId),
      kind: 'tool-call',
      sessionId: String(ctx.sessionId),
      runId: ctx.runId,
      occurredAt: entry.occurredAt,
      payload: {
        callId,
        name: entry.call.name,
        input: structuredClone(entry.call.input),
        stepId: toolStepId(results.get(callId)?.result),
      },
    });
  }
  for (const [callId, entry] of results) {
    records.push({
      id: sourceId(ctx.runId, 'tool-result', callId),
      kind: 'tool-result',
      sessionId: String(ctx.sessionId),
      runId: ctx.runId,
      occurredAt: entry.occurredAt,
      payload: {
        callId,
        ok: entry.result.ok,
        output: structuredClone(entry.result.output),
        error: entry.result.error,
        durationMs: entry.result.durationMs,
        sanitized: entry.result.sanitized,
        stepId: toolStepId(entry.result),
      },
    });
  }

  for (const step of ctx.taskExecution?.steps ?? []) {
    records.push({
      id: sourceId(ctx.runId, 'task-step', step.stepId, String(step.attempt ?? 1)),
      kind: 'task-step',
      sessionId: String(ctx.sessionId),
      runId: ctx.runId,
      occurredAt: step.endedAt ?? step.startedAt,
      payload: {
        stepId: step.stepId,
        title: step.title,
        description: step.description,
        status: step.status,
        acceptanceCriteria: step.acceptanceCriteria,
        expectedOutput: step.expectedOutput,
        output: step.output,
        error: step.error,
        failureKind: step.failureKind,
        attempt: step.attempt,
        toolCallIds: [...step.toolCallIds],
      },
    });
  }

  for (const verification of ctx.verificationHistory ?? []) {
    records.push({
      id: sourceId(ctx.runId, 'verification', String(verification.attempt)),
      kind: 'verification',
      sessionId: String(ctx.sessionId),
      runId: ctx.runId,
      occurredAt: verification.verifiedAt,
      payload: {
        attempt: verification.attempt,
        verdict: verification.verdict,
        reason: verification.reason,
        feedback: verification.feedback,
        failedStepIds: verification.failedStepIds,
        source: verification.source,
      },
    });
  }

  if (ctx.lastError) {
    records.push({
      id: sourceId(ctx.runId, 'run-error'),
      kind: 'run-error',
      sessionId: String(ctx.sessionId),
      runId: ctx.runId,
      occurredAt: ctx.taskExecution?.endedAt ?? ctx.startedAt,
      payload: { stage: ctx.lastError.stage, message: ctx.lastError.message },
    });
  }

  return [...new Map(records.map((record) => [record.id, record])).values()]
    .slice(0, MAX_SOURCE_RECORDS_PER_RUN);
}

export function conversationSourceRefs(ctx: RunContext, limit = 32): string[] {
  return collectConversationSourceRecords(ctx)
    .map((record) => record.id)
    .slice(0, Math.max(0, Math.floor(limit)));
}

function messageSource(message: Message, ctx: RunContext): MemoryConversationSourceInput {
  return {
    id: sourceId(ctx.runId, 'user-message', message.id),
    kind: 'user-message',
    sessionId: String(ctx.sessionId),
    runId: ctx.runId,
    occurredAt: message.timestamp,
    payload: {
      messageId: message.id,
      role: message.role,
      content: structuredClone(message.content),
      clarificationResponse: structuredClone(message.clarificationResponse),
    },
  };
}

function sourceId(runId: string, kind: string, ...parts: string[]): string {
  return ['conversation-source', runId, kind, ...parts].join(':');
}

function toolStepId(result: ToolResult | undefined): string | undefined {
  return typeof result?.meta?.stepId === 'string' ? result.meta.stepId : undefined;
}
