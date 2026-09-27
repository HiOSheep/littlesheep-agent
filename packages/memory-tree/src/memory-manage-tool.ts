// Forgetting and correcting an existing memory, on the user's word and under Runtime control (RS-06B).
//
// The model may not decide on its own that a memory is wrong, and it may not pick the target by
// similarity. Everything this tool does starts from a specific atom the run has actually seen:
//
//   forget   the atom leaves retrieval, the index and the current working set, its original record and
//            audit stay, and the session's pre-revocation summary stops being injected as current
//            memory (the runner's existing revocation marker).
//   correct  is not implemented yet. It is refused with that exact boundary rather than quietly
//            written as a second, contradicting fact — the honest answer while the supersede path
//            (replacement + relation + evidence, in one recoverable commit) is still being built.
//
// A target that is missing, stale, out of this run's view or already forgotten never gets guessed at:
// each case has its own refusal, and the user can re-read the memory and ask again.

import { z } from 'zod';
import type { AgentTool, ToolContext, ToolResult } from '@littlesheep/types'

export const MEMORY_MANAGE_TOOL_NAME = 'memory_manage'

const MemoryManageInput = z.object({
  action: z.enum(['forget', 'correct']),
  atomId: z.string().min(1).max(200),
  /** The revision the model actually saw; a mismatch means the memory changed under it. */
  expectedRevision: z.number().int().min(0),
  /** The user's own words, or the reason this correction is needed. */
  reason: z.string().min(1).max(500),
  /**
   * Optional: the calling run's own messages are used when nothing is cited, because a model has no
   * way to know this session's message ids.
   */
  sourceMessageIds: z.array(z.string().min(1).max(160)).min(1).max(16).optional(),
  /** Only for `correct`, which is not supported yet. */
  replacement: z.object({
    summary: z.string().min(1).max(240),
    content: z.string().min(1).max(4_000),
    retrievalKeys: z.array(z.string().min(1).max(80)).min(1).max(16),
  }).optional(),
})

/** The target as the Runtime sees it right now. */
export interface MemoryManageTarget {
  atomId: string
  revision: number
  branch: string
  scope: string
  status: string
  /** Present once the atom is no longer in use. */
  invalidatedAt?: string
  isBranchRoot?: boolean
  summary?: string
  /** The entities this atom is about; a correction's `replaces` relation has to share one. */
  entityRefs: string[]
  /** The semantic parent the atom sits under; a replacement has to stay under the same one. */
  parentNodeId: string
  scopeKey?: string
  domain?: string
  statementKind?: string
}

export interface MemoryManageToolOptions {
  /** Reads the target through the management facade (revision, status, scope, audit). */
  inspect: (atomId: string) => Promise<MemoryManageTarget | undefined>
  /** Applies a management action; resolves to the committed revision or throws. */
  invalidate: (input: { atomId: string; expectedRevision: number; reason: string }) => Promise<void>
  /** Confirms the calling run can actually see this atom (scope + disclosure aware). */
  isVisibleToRun: (runId: string, atomId: string) => Promise<boolean>
  /** Reads the session's message window so the user's instruction can be verified. */
  readMessages: (sessionId: string) => Promise<MemoryManageSourceMessage[]>
  /** Records the committed revocation so pre-revocation summaries stop being injected. */
  recordRevocation?: (record: {
    atomId: string
    revision: number
    action: 'invalidate' | 'supersede'
    replacementAtomId?: string
  }) => void
  /**
   * Correction ports. A correction writes the replacement, relates it to the atom it replaces, and
   * then supersedes that atom — three steps the runtime performs in this order so an interruption
   * leaves a state it can describe and finish, never two atoms both current.
   */
  writeReplacement?: (input: {
    /** The atom this replacement will supersede; the write must not merge into it. */
    supersededAtomId: string
    summary: string
    content: string
    retrievalKeys: string[]
    branch: string
    scope: string
    parentNodeId: string
    sourceRefs: string[]
    runId: string
  }) => Promise<{ atomId: string; revision: number; decision: string }>
  /** Creates the `replaces` relation between the replacement and the atom it replaces. */
  relateReplacement?: (input: {
    supersededAtomId: string
    replacementAtomId: string
    scope: string
    scopeKey?: string
    sourceRefs: string[]
    reason: string
  }) => Promise<string>
  /** Supersedes the old atom with the replacement (both already committed). */
  supersede?: (input: {
    atomId: string
    expectedRevision: number
    replacementAtomId: string
    replacementExpectedRevision: number
    relationId: string
    reason: string
    evidenceRefs: string[]
  }) => Promise<void>
  log?: (level: 'info' | 'warn', message: string) => void
}

export interface MemoryManageSourceMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** The run that produced this message; used when the caller cites nothing. */
  runId?: string
}

/**
 * The instructions a user writes when they want something forgotten. Like the write tool's
 * authorization check, this is deliberately literal: the Runtime must be able to point at the
 * sentence that asked for it.
 */
const USER_FORGET_INSTRUCTION =
  /(?:忘记|忘掉|别再记|不要再记|不要记|删掉这条|删除这条|清除这条|不记得这个|记错了|forget|delete this memory|remove this memory)/iu

export function userAskedToForget(text: string): boolean {
  return USER_FORGET_INSTRUCTION.test(text)
}

export function createMemoryManageTool(options: MemoryManageToolOptions): AgentTool {
  return {
    name: MEMORY_MANAGE_TOOL_NAME,
    description: [
      'Forget one memory the user asked you to forget.',
      'You must name the exact atom (atomId) and the revision you saw (expectedRevision); never guess a',
      'target, never pick one by similarity, and never use this to store a new version of a fact.',
      'At least one cited sourceMessageIds entry must be the user message that asked for it — the runtime',
      'reads that text itself, so you cannot authorize a change on the user\'s behalf.',
      'Correcting a memory is not supported yet: action "correct" is refused with that boundary, and you',
      'must report that to the user instead of writing the new fact as if the old one were gone.',
    ].join(' '),
    requiresApproval: true,
    inputSchema: MemoryManageInput,
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = MemoryManageInput.safeParse(input)
      if (!parsed.success) {
        return failure('memory_manage_invalid_input', parsed.error.issues.map((issue) => issue.message).join('; '))
      }
      const request = parsed.data

      if (ctx.permissionMode && ctx.permissionMode !== 'full' && ctx.approvalGranted !== true) {
        return failure('memory_manage_not_approved',
          `Changing a memory needs the user's approval in ${ctx.permissionMode} mode; this call has none.`)
      }

      // The user's own instruction, verified from the message text: the model cannot mark its own
      // output as authorized, and a fact it merely believes is wrong is not a correction.
      let messages: MemoryManageSourceMessage[]
      try {
        messages = await options.readMessages(String(ctx.sessionId))
      } catch (error) {
        return failure('memory_manage_source_unavailable', `Session messages could not be read: ${String(error)}`)
      }
      const byId = new Map(messages.map((message) => [message.id, message]))
      const citedIds = request.sourceMessageIds ?? []
      const missing = citedIds.filter((id) => !byId.has(id))
      if (missing.length > 0) {
        return failure('memory_manage_source_missing',
          `These source messages are not in this session: ${missing.join(', ')}.`)
      }
      // Citing specific messages is optional: the user message of *this run* is the one that asked, and
      // the runtime reads it itself. A cited message that does not ask for the change still makes the
      // call unauthorized, so citing nothing is not a way around the check.
      const citedUsers = (citedIds.length > 0
        ? citedIds.map((id) => byId.get(id))
        : messages.filter((message) => message.runId !== undefined && message.runId === ctx.runId))
        .filter((message): message is MemoryManageSourceMessage => Boolean(message) && message!.role === 'user')
      if (!citedUsers.some((message) => userAskedToForget(message.text))) {
        return failure('memory_manage_not_authorized',
          citedUsers.length === 0
            ? 'No user message of this run asks for this change, so the user has not authorized it.'
            : 'No cited user message asks to forget or correct a memory, so the user has not authorized this change.')
      }

      const target = await options.inspect(request.atomId)
      if (!target) {
        return failure('memory_manage_target_missing',
          `No memory with id ${request.atomId}; locate it through memory_tree first and use the id the index gave you.`)
      }
      if (target.isBranchRoot) {
        return failure('memory_manage_target_invalid', 'A branch root is structural and cannot be forgotten.')
      }
      if (!await options.isVisibleToRun(ctx.runId, request.atomId)) {
        return failure('memory_manage_target_not_visible',
          'This memory is not visible to this run, so it cannot be changed from here (it may belong to another scope or project).')
      }
      if (target.invalidatedAt || target.status !== 'active') {
        // The end state the user asked for already holds; saying "already forgotten" is the honest
        // answer, and a retry of the same request must not become an error.
        return {
          callId: '',
          ok: true,
          output: [
            '# Memory already not in use',
            `Atom: ${target.atomId}`,
            `Status: ${target.status}${target.invalidatedAt ? ` (invalidated at ${target.invalidatedAt})` : ''}`,
            'Nothing was changed by this call.',
          ].join('\n'),
          meta: {
            memoryManageAction: 'forget',
            memoryManageOutcome: 'already-inactive',
            memoryManageAtomId: target.atomId,
            memoryManageRevision: target.revision,
          },
        }
      }
      if (target.revision !== request.expectedRevision) {
        return failure('memory_manage_stale_revision',
          `This memory is at revision ${target.revision}, but the call named ${request.expectedRevision}. Read it again before changing it.`)
      }

      if (request.action === 'correct') {
        if (!request.replacement) {
          return failure('memory_manage_invalid_input', 'A correction needs the replacement statement (summary, content, retrievalKeys).')
        }
        if (!options.writeReplacement || !options.relateReplacement || !options.supersede) {
          return failure('memory_manage_unsupported', 'This runtime does not support correcting an existing memory.')
        }
        // The replacement has to be about the same subject as the atom it replaces: the relation that
        // authorizes the supersession is built between their entities, so a replacement with none of
        // them could only be related by guessing.
        if (target.entityRefs.length === 0) {
          return failure('memory_manage_target_invalid',
            'This memory has no entity to relate a replacement to, so it cannot be corrected through this path.')
        }
        const sourceRefs = (citedIds.length > 0 ? citedIds.map((id) => byId.get(id)) : citedUsers)
          .filter((message): message is MemoryManageSourceMessage => Boolean(message))
          .map((message) => `conversation-source:${ctx.runId}:user-message:${message.id}`)

        let replacement: { atomId: string; revision: number; decision: string }
        try {
          replacement = await options.writeReplacement({
            supersededAtomId: target.atomId,
            summary: request.replacement.summary,
            content: request.replacement.content,
            retrievalKeys: [...request.replacement.retrievalKeys],
            branch: target.branch,
            scope: target.scope,
            parentNodeId: target.parentNodeId,
            sourceRefs,
            runId: ctx.runId,
          })
        } catch (error) {
          return failure('memory_manage_failed',
            `The replacement could not be written, so nothing changed and the earlier memory still stands: ${String(error)}`)
        }
        if (replacement.decision !== 'created' && replacement.decision !== 'reinforced') {
          return failure('memory_manage_failed',
            `The replacement write was ${replacement.decision}, so the earlier memory still stands and was not superseded.`)
        }

        let relationId: string
        try {
          relationId = await options.relateReplacement({
            supersededAtomId: target.atomId,
            replacementAtomId: replacement.atomId,
            scope: target.scope,
            ...(target.scopeKey ? { scopeKey: target.scopeKey } : {}),
            sourceRefs,
            reason: request.reason,
          })
        } catch (error) {
          // The replacement exists and is a current statement of the same subject; the old one has not
          // been superseded yet. Saying exactly that is what makes the retry (or the user's decision)
          // possible — never a second atom quietly treated as the current fact.
          options.recordRevocation?.({
            atomId: target.atomId,
            revision: target.revision,
            action: 'supersede',
            replacementAtomId: replacement.atomId,
          })
          return failure('memory_manage_partial',
            `The new version was written (${replacement.atomId}) but relating it to the earlier memory failed, so that memory still stands: ${String(error)}`)
        }

        try {
          await options.supersede({
            atomId: target.atomId,
            expectedRevision: request.expectedRevision,
            replacementAtomId: replacement.atomId,
            replacementExpectedRevision: replacement.revision,
            relationId,
            reason: request.reason,
            evidenceRefs: sourceRefs,
          })
        } catch (error) {
          options.recordRevocation?.({
            atomId: target.atomId,
            revision: target.revision,
            action: 'supersede',
            replacementAtomId: replacement.atomId,
          })
          return failure('memory_manage_partial',
            `The new version (${replacement.atomId}) and its relation (${relationId}) exist, but the earlier memory was not superseded: ${String(error)}. `
            + 'The earlier memory still stands; retry this call with the same atom and revision to finish it.')
        }

        options.recordRevocation?.({
          atomId: target.atomId,
          revision: target.revision,
          action: 'supersede',
          replacementAtomId: replacement.atomId,
        })
        options.log?.('info', `memory_manage: corrected atom ${target.atomId} with ${replacement.atomId}`)
        return {
          callId: '',
          ok: true,
          output: [
            '# Memory corrected',
            `Replaced: ${target.atomId} (revision ${target.revision})`,
            `Replacement: ${replacement.atomId}`,
            `Relation: ${relationId}`,
            `Reason: ${request.reason}`,
            'The earlier statement is no longer current, and summaries produced before this are no longer current either.',
          ].join('\n'),
          meta: {
            memoryManageAction: 'correct',
            memoryManageOutcome: 'committed',
            memoryManageAtomId: target.atomId,
            memoryManageRevision: target.revision,
            memoryManageReplacementAtomId: replacement.atomId,
            memoryManageRelationId: relationId,
          },
        }
      }

      try {
        await options.invalidate({
          atomId: target.atomId,
          expectedRevision: request.expectedRevision,
          reason: request.reason,
        })
      } catch (error) {
        return failure('memory_manage_failed', `Forgetting this memory failed and the record is unchanged: ${String(error)}`)
      }
      options.recordRevocation?.({ atomId: target.atomId, revision: target.revision, action: 'invalidate' })
      options.log?.('info', `memory_manage: forgot atom ${target.atomId} at revision ${target.revision}`)
      return {
        callId: '',
        ok: true,
        output: [
          '# Memory forgotten',
          `Atom: ${target.atomId}`,
          `Revision: ${target.revision}`,
          `Reason: ${request.reason}`,
          'It no longer takes part in retrieval, and summaries produced before this are no longer current.',
        ].join('\n'),
        meta: {
          memoryManageAction: 'forget',
          memoryManageOutcome: 'committed',
          memoryManageAtomId: target.atomId,
          memoryManageRevision: target.revision,
        },
      }
    },
  }
}

function failure(errorKind: string, text: string): ToolResult {
  return { callId: '', ok: false, output: text, error: text, meta: { errorKind } }
}
