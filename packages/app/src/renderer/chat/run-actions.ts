// Owns one streamed Agent run, its progress events, approval bridge, stop behavior, and final message reduction.
import '@xterm/xterm/css/xterm.css'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import {
  runAgentStream,
  sendRuntimeControlEvent,
  type ApprovalRequest,
  type AttachmentRef,
  type PermissionModeId,
  type RuntimeState,
  type SessionMeta
} from '../api'
import {
  SessionApprovalGrantStore,
  sessionApprovalScopeKey,
  type ApprovalDecision
} from '../approval-grants'
import { formatUserMessage } from '../composer/message-files'
import {
  buildContextUsageSnapshot,
  type ContextUsageSnapshot
} from '../context-usage'
import { createAssistantDeltaBuffer } from './assistant-delta-buffer'
import { localMessageId, updateLastAssistantText } from './live-message-updates'
import { settleLiveReasoning } from './activity-model'
import { handleRunToolEvent } from './run-event-handlers'
import { reduceCompletedRunMessages } from './run-result-reducer'
import { conversationTurnFingerprint } from './conversation-turn-fingerprint'
import { attemptStreamLossRecovery } from './run-transport-recovery'
import { ChatMessage } from './types'
import { sendActiveRunUpdate } from './active-run-update'
import type { RuntimeTaskEventIdentity, RuntimeTaskEventNotice } from '../runtime-events/runtime-task-events'

export interface RunActionContext {
  abortRef: MutableRefObject<AbortController | null>
  activeRunIdRef: MutableRefObject<string | null>
  activeApprovalScopeKey: (sessionId?: string) => string
  appMountedRef: MutableRefObject<boolean>
  approvalGrantsRef: MutableRefObject<SessionApprovalGrantStore>
  attachments: AttachmentRef[]
  conversationViewRequestRef: MutableRefObject<number>
  currentSession: string | undefined
  input: string
  liveToolStepRef: MutableRefObject<Map<string, string>>
  loading: boolean
  permissionMode: PermissionModeId
  pendingRuntimeMessageRef: MutableRefObject<{
    runId: string
    text: string
    identity: RuntimeTaskEventIdentity
  } | null>
  pendingConversationTurnRef: MutableRefObject<{
    fingerprint: string
    requestKey: string
  } | null>
  publishRuntimeEventNotice: (notice: RuntimeTaskEventNotice | null) => void
  refreshProjects: () => Promise<void>
  refreshSessions: () => Promise<SessionMeta[]>
  requestApprovalForScope: (request: ApprovalRequest, scopeKey: string) => Promise<boolean>
  runtime: RuntimeState | null
  sessionOwnership: Pick<SessionMeta, 'scope' | 'projectId'>
  setActivityNow: Dispatch<SetStateAction<number>>
  setAttachments: Dispatch<SetStateAction<AttachmentRef[]>>
  setContextUsageSnapshot: Dispatch<SetStateAction<ContextUsageSnapshot | null>>
  setCurrentSession: Dispatch<SetStateAction<string | undefined>>
  setInput: Dispatch<SetStateAction<string>>
  setLoading: Dispatch<SetStateAction<boolean>>
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
  setWorkspaceArtifactVersion: Dispatch<SetStateAction<number>>
  settleApprovalPrompt: (decision: ApprovalDecision) => void
  stopRequestedRunIdRef: MutableRefObject<string | null>
}

export function createRunActions(context: RunActionContext) {
  const {
    abortRef, activeRunIdRef, appMountedRef, conversationViewRequestRef, liveToolStepRef,
    pendingConversationTurnRef, pendingRuntimeMessageRef, stopRequestedRunIdRef,
    activeApprovalScopeKey, approvalGrantsRef, permissionMode, requestApprovalForScope, settleApprovalPrompt,
    attachments, currentSession, input, loading, runtime, sessionOwnership,
    publishRuntimeEventNotice, refreshProjects, refreshSessions,
    setActivityNow, setAttachments, setContextUsageSnapshot, setCurrentSession, setInput,
    setLoading, setMessages, setWorkspaceArtifactVersion,
  } = context

  /** `instructionOverride` is the failed turn's own instruction (its retry action); without it the run sends the composer's draft. */
  async function send(instructionOverride?: string) {
    const retrying = instructionOverride !== undefined
    const text = (instructionOverride ?? input).trim()
    if (loading) {
      // A retry is not a mid-run supplement, and session switching aborts the previous controller
      // before its SSE finally block releases the shared loading flag — the new conversation's
      // input stays local during that narrow handoff window.
      if (retrying || abortRef.current?.signal.aborted) return
      await sendActiveRunUpdate(text, {
        activeRunIdRef,
        appMountedRef,
        hasAttachments: attachments.length > 0,
        pendingRuntimeMessageRef,
        publishRuntimeEventNotice,
        setMessages,
        setInput,
      })
      return
    }
    if (!text && (retrying || attachments.length === 0)) return
    const activeAttachments = retrying ? [] : attachments
    const turnFingerprint = conversationTurnFingerprint({
      text: text || '请根据附件继续处理。',
      sessionId: currentSession,
      permissionMode,
      workspace: runtime?.workspace,
      sessionScope: sessionOwnership.scope,
      projectId: sessionOwnership.projectId,
      reasoning: runtime?.reasoning,
      profile: runtime?.profile,
      attachments: activeAttachments,
    })
    const requestKey = pendingConversationTurnRef.current?.fingerprint === turnFingerprint
      ? pendingConversationTurnRef.current.requestKey
      : crypto.randomUUID()
    pendingConversationTurnRef.current = { fingerprint: turnFingerprint, requestKey }
    const displayText = formatUserMessage(text, activeAttachments)
    const controller = new AbortController()
    const conversationViewRequest = conversationViewRequestRef.current
    const ownsVisibleConversation = () => (
      appMountedRef.current && conversationViewRequestRef.current === conversationViewRequest
    )
    const activityStartedAt = Date.now()
    const approvalScopeKey = activeApprovalScopeKey()
    abortRef.current = controller
    activeRunIdRef.current = null
    pendingRuntimeMessageRef.current = null
    stopRequestedRunIdRef.current = null
    publishRuntimeEventNotice(null)
    if (!retrying) setInput('') // a retry consumes nothing: its text is the failed turn's
    if (!retrying) setAttachments([])
    setActivityNow(activityStartedAt)
    setMessages((m) => [
      ...m,
      { id: localMessageId('user'), role: 'user', text: displayText, timestamp: new Date(activityStartedAt).toISOString(), attachments: activeAttachments },
      {
        id: localMessageId('assistant'),
        role: 'assistant',
        text: '',
        timestamp: new Date(activityStartedAt).toISOString(),
        activityCollapsed: false,
        activity: {
          status: 'running',
          visibility: 'progress',
          instruction: displayText,
          startedAt: activityStartedAt,
          reasoning: [{
            phaseId: 'request:dispatch',
            source: 'runtime',
            activityKind: 'request_dispatch',
            summary: /[\u3400-\u9fff]/u.test(text)
              ? '请求已发出，正在等待 Runtime 接收'
              : 'Request sent; waiting for Runtime to accept it',
            status: 'running',
            startedAt: activityStartedAt,
          }],
          steps: [],
          tools: [],
        },
      },
    ])
    liveToolStepRef.current.clear()
    setLoading(true)
    const deltaBuffer = createAssistantDeltaBuffer((delta) => {
      if (!ownsVisibleConversation()) return
      setMessages((messages) => updateLastAssistantText(messages, (text) => text + delta))
    })
    const recoveryHost = { setMessages, setCurrentSession, setWorkspaceArtifactVersion, pendingConversationTurnRef, deltaBuffer, refreshSessions, refreshProjects }
    try {
      const result = await runAgentStream(text || '请根据附件继续处理。', currentSession, permissionMode, {
        signal: controller.signal,
        onStart: ({ runId }) => {
          if (ownsVisibleConversation()) activeRunIdRef.current = runId
        },
        onApprovalRequest: (request) => ownsVisibleConversation()
          ? requestApprovalForScope(request, approvalScopeKey)
          : Promise.resolve(false),
        onToolEvent: (evt) => {
          if (ownsVisibleConversation()) {
            handleRunToolEvent(evt, { appMountedRef, liveToolStepRef, setMessages })
          }
        },
        onDelta: (delta) => {
          if (!ownsVisibleConversation()) return
          deltaBuffer.push(delta)
        },
        onReplace: (text) => {
          if (!ownsVisibleConversation()) return
          deltaBuffer.clear()
          setMessages((messages) => updateLastAssistantText(messages, () => text))
        },
      }, {
        workspace: runtime?.workspace,
        sessionScope: sessionOwnership.scope,
        projectId: sessionOwnership.projectId,
        reasoning: runtime?.reasoning,
        profile: runtime?.profile,
        attachments: activeAttachments,
        requestKey,
      })
      if (pendingConversationTurnRef.current?.requestKey === requestKey) {
        pendingConversationTurnRef.current = null
      }
      if (!appMountedRef.current) return
      approvalGrantsRef.current.promote(approvalScopeKey, sessionApprovalScopeKey(result.sessionId))
      setWorkspaceArtifactVersion((value) => value + 1)
      if (ownsVisibleConversation()) {
        deltaBuffer.flush()
        setCurrentSession(result.sessionId)
        setContextUsageSnapshot(buildContextUsageSnapshot(
          runtime?.model,
          result.usage,
          result.contextSnapshots,
          result.modelRequests,
        ))
        setMessages((messages) => reduceCompletedRunMessages(messages, result))
      } else {
        deltaBuffer.clear()
      }
      void refreshSessions()
      void refreshProjects()
    } catch (e) {
      let failure = e
      // A dropped SSE observer is not a failed run: reconcile against the authoritative log first.
      const recovery = await attemptStreamLossRecovery({
        runId: activeRunIdRef.current ?? undefined,
        signal: controller.signal,
        error: e,
        ownsVisibleConversation,
        host: recoveryHost,
      })
      if (recovery.kind === 'recovered') return
      if (recovery.kind === 'failed') failure = recovery.error
      if (
        ((failure as Error).name === 'AbortError' || (failure as Error).name === 'RunStreamServerError')
        && pendingConversationTurnRef.current?.requestKey === requestKey
      ) {
        pendingConversationTurnRef.current = null
      }
      if (!ownsVisibleConversation()) return
      deltaBuffer.flush()
      // The text goes back only when the composer sent it; a retry never writes into the composer.
      if (!retrying) setInput((current) => current.trim() ? current : text)
      if (!retrying) setAttachments((current) => current.length > 0 ? current : activeAttachments)
      if ((failure as Error).name === 'AbortError') {
        setMessages((m) => {
          const next = [...m]
          const last = next[next.length - 1]
          if (last?.role === 'assistant') {
            const endedAt = Date.now()
            next[next.length - 1] = {
              ...last,
              text: '',
              activityCollapsed: true,
              activity: last.activity
                ? {
                  ...last.activity,
                  status: 'aborted',
                  error: '本次运行已停止。',
                  endedAt,
                  durationMs: endedAt - last.activity.startedAt,
                  reasoning: settleLiveReasoning(last.activity.reasoning, 'aborted', endedAt),
                }
                : undefined,
            }
          }
          return next
        })
        return
      }
      setMessages((m) => {
        const next = [...m]
        const last = next[next.length - 1]
        const error = (failure as Error).message
        if (last?.role === 'assistant') {
          const endedAt = Date.now()
          next[next.length - 1] = {
            ...last,
            text: last.text,
            activityCollapsed: true,
            activity: last.activity
              ? {
                ...last.activity,
                status: 'failed',
                error,
                endedAt,
                durationMs: endedAt - last.activity.startedAt,
                reasoning: settleLiveReasoning(last.activity.reasoning, 'failed', endedAt),
              }
              : undefined,
          }
        }
        return next
      })
    } finally {
      deltaBuffer.dispose()
      if (abortRef.current === controller) {
        settleApprovalPrompt('deny')
        abortRef.current = null
        activeRunIdRef.current = null
        stopRequestedRunIdRef.current = null
        liveToolStepRef.current.clear()
        if (appMountedRef.current) setLoading(false)
      }
    }
  }

  function stop() {
    settleApprovalPrompt('deny')
    const runId = activeRunIdRef.current
    if (!runId) {
      // No run identity yet: the local stream is the only thing to stop.
      abortRef.current?.abort()
      return
    }
    // One interrupt per run. The composer keeps showing "正在停止" until the
    // run settles, and a repeated click must not queue a second request.
    if (stopRequestedRunIdRef.current === runId) return
    stopRequestedRunIdRef.current = runId
    void sendRuntimeControlEvent(runId, 'interrupt_requested', 'user-requested-stop')
      .then((outcome) => {
        if (outcome.kind === 'rejected') abortRef.current?.abort()
      })
      .catch(() => {
        abortRef.current?.abort()
      })
  }
  /**
   * Re-run a failed turn's own instruction — the transcript's retry action, and nothing more than
   * the send entry above with that text: the failed turn keeps its failure (a successful retry
   * appends its own instruction and turn), and resuming *from* the failure point is the harness's
   * RECOVER route rather than this action.
   */
  function retryFailedTurn(instruction: string) {
    void send(instruction)
  }
  return { send, retryFailedTurn, stop }
}
