import type { LlmClient } from '@littlesheep/llm'
import { callLlmForJson } from '@littlesheep/harness'
import type { ClarificationRequest, RunCheckpoint } from '@littlesheep/types'

export type ContinuationDispositionKind =
  | 'answer'
  | 'retry'
  | 'revise_goal'
  | 'cancel'
  | 'new_task'
  | 'ambiguous'

export type ContinuationDirective = 'auto' | Exclude<ContinuationDispositionKind, 'ambiguous'>

export interface ResolveContinuationDispositionOptions {
  llm: LlmClient
  model: string
  checkpoint: RunCheckpoint
  request: ClarificationRequest
  answer: string
  directive?: ContinuationDirective
  signal?: AbortSignal
}

export interface ContinuationDispositionDecision {
  kind: ContinuationDispositionKind
  source: 'directive' | 'model' | 'runtime_fallback'
  reason?: string
}

const SYSTEM_PROMPT = `You resolve what one structurally bound user turn means for an existing waiting LittleSheep task.

The Runtime has already proven that the old task and clarification exist. Do not decide whether the task exists. Choose only one disposition:
- answer: supplies requested facts or choices.
- retry: says a blocker such as permission, login, tool, or resource availability changed and asks to try again.
- revise_goal: changes the scope, output, or acceptance criteria of the same task.
- cancel: explicitly ends the old task.
- new_task: explicitly starts an unrelated replacement task instead of answering the old one.
- ambiguous: none of the above can be chosen safely.

Prefer answer or retry when the message directly responds to the pending question. Do not choose new_task merely because the answer mentions another action. Return only JSON:
{"kind":"answer"|"retry"|"revise_goal"|"cancel"|"new_task"|"ambiguous","reason":"short explanation"}`

const KINDS = new Set<ContinuationDispositionKind>([
  'answer', 'retry', 'revise_goal', 'cancel', 'new_task', 'ambiguous',
])

export async function resolveContinuationDisposition(
  options: ResolveContinuationDispositionOptions,
): Promise<ContinuationDispositionDecision> {
  if (options.directive && options.directive !== 'auto') {
    return { kind: options.directive, source: 'directive' }
  }
  const task = options.checkpoint.taskBook
  const boundedFacts = {
    pendingRequest: {
      kind: options.request.kind,
      sourceStage: options.request.sourceStage,
      blockingReason: clip(options.request.blockingReason, 1_024),
      questions: options.request.questions.slice(0, 8).map((question) => ({
        field: question.field,
        prompt: clip(question.prompt, 512),
      })),
    },
    task: task ? {
      goal: clip(task.goal, 1_024),
      successCriteria: task.successCriteria.slice(0, 16).map((item) => clip(item, 512)),
    } : undefined,
    answer: clip(options.answer, 16_384),
  }
  try {
    const { parsed } = await callLlmForJson<{ kind?: unknown; reason?: unknown }>(
      options.llm,
      options.model,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(boundedFacts) },
      ],
      {
        maxAttempts: 2,
        maxTokens: 240,
        maxTokensCeiling: 360,
        temperature: 0,
        signal: options.signal,
      },
    )
    if (parsed && typeof parsed.kind === 'string' && KINDS.has(parsed.kind as ContinuationDispositionKind)) {
      return {
        kind: parsed.kind as ContinuationDispositionKind,
        source: 'model',
        ...(typeof parsed.reason === 'string' && parsed.reason.trim()
          ? { reason: clip(parsed.reason.trim(), 512) }
          : {}),
      }
    }
    return { kind: 'ambiguous', source: 'runtime_fallback', reason: 'model returned an invalid continuation disposition' }
  } catch (error) {
    return {
      kind: 'ambiguous',
      source: 'runtime_fallback',
      reason: `continuation disposition failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function clip(value: string, maximum: number): string {
  return value.length > maximum ? value.slice(0, maximum) : value
}
