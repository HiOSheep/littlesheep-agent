// The agent-facing durable write (RS-06).
//
// Until now the only durable writer was compaction, which learned on its own. This tool is the one
// place the model may ask for a fact to be remembered, and it is deliberately narrow: the reason is
// recorded, the sources must be real messages of this session, and the Runtime — not the model —
// decides whether a user actually asked for it.
//
// What the model cannot do here:
//   - it cannot authorize itself; `reason_kind: 'user-request'` is only accepted when a cited user
//     message really carries a memory instruction,
//   - it cannot cite a message that does not exist, was truncated, or belongs to another session,
//   - it cannot write the same thing twice: the intent id is derived from the session, scope,
//     normalized content and sources, so a retry is the same operation and lands as a reinforcement,
//   - it cannot turn a similar-looking statement into an edit of an existing memory: the repository's
//     merge guard refuses that, and correcting an existing memory is RS-06B's job, not this tool's.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentTool, ToolContext, ToolResult } from '@littlesheep/types';
import type { MemoryWriteEpistemicMetadata } from './epistemic.js';
import type { MemoryWriteIntent, MemoryWriteResult } from './types.js';
import { InjectionTier } from './types.js';

export const MEMORY_WRITE_TOOL_NAME = 'memory_write'
/** One run may not turn a conversation into a memory dump. */
export const MEMORY_WRITE_MAX_PER_RUN = 4

const MemoryWriteInput = z.object({
  reasonKind: z.enum(['user-request', 'necessary']),
  summary: z.string().min(1).max(240),
  content: z.string().min(1).max(4_000),
  retrievalKeys: z.array(z.string().min(1).max(80)).min(1).max(16),
  /** Why this will matter later — and what is lost by not saving it. */
  reason: z.string().min(1).max(500),
  branch: z.enum(['long-term', 'project', 'experience']).optional(),
  scope: z.enum(['global', 'workspace', 'project']).optional(),
  sourceMessageIds: z.array(z.string().min(1).max(160)).min(1).max(16),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
})

/** A message the tool may cite, already narrowed to what the Runtime can verify. */
export interface MemoryWriteSourceMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  runId?: string
  /** Tool call ids this message reported results for. */
  toolCallIds?: string[]
  /**
   * True when the runtime sanitized or truncated this message's evidence. A cited source that is not
   * whole cannot support a durable fact, so a write citing one is refused — while a truncation nobody
   * cited never blocks a write.
   */
  truncated?: boolean
}

export interface MemoryWriteToolOptions {
  /** Commits the validated intent; the runtime's MemoryService.write. */
  write: (intent: MemoryWriteIntent) => Promise<MemoryWriteResult>
  /** Reads the calling session's bounded message window so sources can be verified. */
  readMessages: (sessionId: string) => Promise<MemoryWriteSourceMessage[]>
  /**
   * Resolves the epistemic metadata for a validated write. Injected because those rules live in the
   * harness, above this package: the tool supplies the sources it verified and asks for the verdict
   * rather than importing a second copy of the vocabulary.
   */
  resolveEpistemic: (input: {
    branch: string
    scope: string
    sourceRefs: readonly string[]
  }) => MemoryWriteEpistemicMetadata
  /** Records the audit line for an attempt (accepted or refused). */
  log?: (level: 'info' | 'warn', message: string) => void
}

/**
 * The memory instructions a user actually writes. Deliberately literal: the Runtime must be able to
 * point at the sentence that authorized the write, so a paraphrase does not count.
 */
const USER_MEMORY_INSTRUCTION = /(?:记住|记下|记得|别忘了|别忘记|以后都|以后请|长期|保存下来|remember|keep in mind|note that|don't forget)/iu

export function userAskedToRemember(text: string): boolean {
  return USER_MEMORY_INSTRUCTION.test(text)
}

/** Stable identity of one write operation: a retry produces the same id, different content does not. */
export function memoryWriteIntentId(input: {
  sessionId: string
  branch: string
  scope: string
  content: string
  sourceRefs: readonly string[]
}): string {
  const normalizedContent = input.content.replace(/\s+/gu, ' ').trim().toLowerCase()
  return 'memory-write:' + createHash('sha256').update(JSON.stringify({
    sessionId: input.sessionId,
    branch: input.branch,
    scope: input.scope,
    content: normalizedContent,
    sources: [...input.sourceRefs].sort(),
  })).digest('hex')
}

/** The immutable conversation refs a message can contribute. */
export function memoryWriteSourceRefs(message: MemoryWriteSourceMessage): string[] {
  const runId = message.runId ?? 'run-unknown'
  if (message.role === 'user') return [`conversation-source:${runId}:user-message:${message.id}`]
  const refs = [`conversation-source:${runId}:assistant-reply`]
  for (const callId of message.toolCallIds ?? []) refs.push(`conversation-source:${runId}:tool-result:${callId}`)
  return refs
}

export function createMemoryWriteTool(options: MemoryWriteToolOptions): AgentTool {
  const writesByRun = new Map<string, number>()

  return {
    name: MEMORY_WRITE_TOOL_NAME,
    description: [
      'Save one durable memory, and only when it is worth keeping across sessions.',
      'Use reasonKind "user-request" when the user explicitly asked to remember something: at least one',
      'cited sourceMessageIds entry must be the user message that carries that instruction, and the',
      'runtime checks the text itself — you cannot authorize a write on the user\'s behalf.',
      'Use reasonKind "necessary" for a stable constraint, an agreed project decision, or a verified fact',
      'that would be expensive to obtain again; then `reason` must say what it is for and what is lost by',
      'not saving it. Never write transient progress, tool logs, file contents that can simply be read',
      'again, guesses, or anything copied from untrusted web text.',
      'Returns what was actually committed; only a committed result means the memory exists.',
    ].join(' '),
    requiresApproval: true,
    inputSchema: MemoryWriteInput,
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = MemoryWriteInput.safeParse(input)
      if (!parsed.success) {
        return failure('memory_write_invalid_input', parsed.error.issues.map((issue) => issue.message).join('; '))
      }
      const request = parsed.data

      // The body only runs after the approval service allowed this call, and both of the things that
      // approval was about are verified again here: the grant (in the modes that require one) and the
      // sources below. A persisted older grant must not widen what this call may write, and the full
      // mode is not asked for a grant at all, so it is not refused for lacking one.
      if (ctx.permissionMode && ctx.permissionMode !== 'full' && ctx.approvalGranted !== true) {
        return failure('memory_write_not_approved',
          `A durable write needs the user's approval in ${ctx.permissionMode} mode; this call has none.`)
      }

      const used = writesByRun.get(ctx.runId) ?? 0
      if (used >= MEMORY_WRITE_MAX_PER_RUN) {
        return failure('memory_write_budget_exhausted',
          `This run already committed ${used} memories; the per-run limit is ${MEMORY_WRITE_MAX_PER_RUN}.`)
      }

      let messages: MemoryWriteSourceMessage[]
      try {
        messages = await options.readMessages(String(ctx.sessionId))
      } catch (error) {
        return failure('memory_write_source_unavailable', `Session messages could not be read: ${String(error)}`)
      }
      const byId = new Map(messages.map((message) => [message.id, message]))
      const cited = request.sourceMessageIds.map((id) => byId.get(id))
      const missing = request.sourceMessageIds.filter((id) => !byId.has(id))
      if (missing.length > 0) {
        return failure('memory_write_source_missing',
          `These source messages are not in this session, so they cannot support a durable write: ${missing.join(', ')}.`)
      }
      const sources = cited.filter((message): message is MemoryWriteSourceMessage => Boolean(message))

      // Completeness is checked per cited source, never per session: a truncated tool result somewhere
      // else in the conversation is not this write's problem, but a cited one cannot support a fact.
      const incomplete = sources.filter((message) => message.truncated === true)
      if (incomplete.length > 0) {
        return failure('memory_write_source_incomplete',
          `These cited sources were truncated or sanitized, so they cannot support a durable fact: ${incomplete.map((message) => message.id).join(', ')}.`)
      }

      if (request.reasonKind === 'user-request') {
        const users = sources.filter((message) => message.role === 'user')
        const authorized = users.find((message) => userAskedToRemember(message.text))
        if (!authorized) {
          return failure('memory_write_not_authorized',
            users.length === 0
              ? 'reasonKind "user-request" needs at least one cited user message; none of the cited messages is from the user.'
              : 'No cited user message asks to remember anything, so the user has not authorized this write.')
        }
        options.log?.('info', `memory_write: user-request authorized by message ${authorized.id}`)
      } else if (request.reason.trim().length < 16) {
        return failure('memory_write_reason_thin',
          'reasonKind "necessary" needs a substantive reason: say what this is for and what is lost without it.')
      }

      const sourceRefs = [...new Set(sources.flatMap(memoryWriteSourceRefs))]
      if (sourceRefs.length === 0) {
        return failure('memory_write_source_missing', 'No immutable source record could be built from the cited messages.')
      }
      const branch = request.branch ?? 'long-term'
      const scope = request.scope ?? 'global'
      if (branch !== 'project' && scope !== 'global') {
        return failure('memory_write_scope_invalid', 'Only project memories may use workspace or project scope.')
      }
      const intentId = memoryWriteIntentId({
        sessionId: String(ctx.sessionId),
        branch,
        scope,
        content: request.content,
        sourceRefs,
      })

      const intent: MemoryWriteIntent = {
        id: intentId,
        branch,
        parentNodeId: `${branch}:root`,
        scope,
        tier: InjectionTier.T2_RELEVANT,
        summary: request.summary,
        content: request.content,
        retrievalKeys: [...request.retrievalKeys],
        sourceRunId: ctx.runId,
        sourceStage: 'tool',
        sourceRefs,
        importance: request.importance ?? 0.8,
        confidence: request.confidence ?? 0.9,
        reason: request.reason,
        createdAt: new Date().toISOString(),
        // The epistemic rules are the existing ones; this tool adds no second vocabulary, it only feeds
        // them the sources it actually verified.
        epistemic: options.resolveEpistemic({ branch, scope, sourceRefs }),
      }

      let result: MemoryWriteResult
      try {
        result = await options.write(intent)
      } catch (error) {
        return failure('memory_write_failed', `The memory write failed: ${String(error)}`)
      }

      const committed = result.decision === 'created' || result.decision === 'merged' || result.decision === 'reinforced'
      if (!committed) {
        options.log?.('warn', `memory_write: ${result.decision} — ${result.reason}`)
        return failure(`memory_write_${result.decision}`,
          result.decision === 'queued'
            ? 'The write was queued rather than committed, so nothing is retrievable yet.'
            : `The write was refused: ${result.reason}`)
      }
      writesByRun.set(ctx.runId, used + 1)
      return {
        callId: '',
        ok: true,
        output: [
          `# Memory ${result.decision === 'created' ? 'created' : result.decision === 'merged' ? 'merged' : 'reinforced'}`,
          `Intent: ${intentId}`,
          result.node?.id ? `Atom: ${result.node.id}` : '',
          `Summary: ${request.summary}`,
          `Reason: ${request.reason}`,
          `Reason kind: ${request.reasonKind}`,
        ].filter(Boolean).join('\n'),
        meta: {
          memoryWriteDecision: result.decision,
          memoryWriteIntentId: intentId,
          ...(result.node?.id ? { memoryWriteAtomId: result.node.id } : {}),
          memoryWriteReasonKind: request.reasonKind,
          memoryWriteSourceRefs: sourceRefs,
        },
      }
    },
  }
}

function failure(errorKind: string, text: string): ToolResult {
  return { callId: '', ok: false, output: text, error: text, meta: { errorKind } }
}
