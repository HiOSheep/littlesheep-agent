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
import { buildArtifactsFromToolCalls, buildTraceData, taskStepToLiveStep } from './activity-model'
import { handleRunToolEvent } from './run-event-handlers'
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
  const { abortRef, activeRunIdRef, activeApprovalScopeKey, appMountedRef, approvalGrantsRef, attachments, currentSession, input, liveToolStepRef, loading, permissionMode, pendingRuntimeMessageRef, publishRuntimeEventNotice, refreshProjects, refreshSessions, requestApprovalForScope, runtime, sessionOwnership, setActivityNow, setAttachments, setContextUsageSnapshot, setCurrentSession, setInput, setLoading, setMessages, setWorkspaceArtifactVersion, settleApprovalPrompt, stopRequestedRunIdRef } = context


  async function send() {
    const text = input.trim()
    if (loading) {
      await sendActiveRunUpdate(text, {
        activeRunIdRef,
        appMountedRef,
        hasAttachments: attachments.length > 0,
        pendingRuntimeMessageRef,
        publishRuntimeEventNotice,
        setInput,
      })
      return
    }
    if (!text && attachments.length === 0) return
    const activeAttachments = attachments
    const displayText = formatUserMessage(text, activeAttachments)
    const controller = new AbortController()
    const activityStartedAt = Date.now()
    const approvalScopeKey = activeApprovalScopeKey()
    abortRef.current = controller
    activeRunIdRef.current = null
    pendingRuntimeMessageRef.current = null
    stopRequestedRunIdRef.current = null
    publishRuntimeEventNotice(null)
    setInput('')
    setAttachments([])
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
          instruction: displayText,
          startedAt: activityStartedAt,
          steps: [],
          tools: [],
        },
      },
    ])
    liveToolStepRef.current.clear()
    setLoading(true)
    const deltaBuffer = createAssistantDeltaBuffer((delta) => {
      if (!appMountedRef.current) return
      setMessages((messages) => updateLastAssistantText(messages, (text) => text + delta))
    })
    try {
      const result = await runAgentStream(text || '请根据附件继续处理。', currentSession, permissionMode, {
        signal: controller.signal,
        onStart: ({ runId }) => {
          activeRunIdRef.current = runId
        },
        onApprovalRequest: (request) => appMountedRef.current
          ? requestApprovalForScope(request, approvalScopeKey)
          : Promise.resolve(false),
        onToolEvent: (evt) => handleRunToolEvent(evt, { appMountedRef, liveToolStepRef, setMessages }),
        onDelta: (delta) => {
          if (!appMountedRef.current) return
          deltaBuffer.push(delta)
        },
        onReplace: (text) => {
          if (!appMountedRef.current) return
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
      })
      if (!appMountedRef.current) return
      deltaBuffer.flush()
      approvalGrantsRef.current.promote(approvalScopeKey, sessionApprovalScopeKey(result.sessionId))
      setCurrentSession(result.sessionId)
      setContextUsageSnapshot(buildContextUsageSnapshot(
        runtime?.model,
        result.usage,
        result.contextSnapshots,
        result.modelRequests,
      ))
      setWorkspaceArtifactVersion((value) => value + 1)
      setMessages((m) => {
        const next = [...m]
        const last = next[next.length - 1]
        const traceData = buildTraceData(result)
        const artifacts = buildArtifactsFromToolCalls(traceData.toolCalls)
        if (last?.role === 'assistant') {
          const endedAt = Date.now()
          const taskSteps = result.taskExecution?.steps?.map((step) => taskStepToLiveStep(step)) ?? []
          const currentActivity = last.activity
          next[next.length - 1] = {
            ...last,
            text: last.text || (result.status === 'ok' ? result.reply : ''),
            ...traceData,
            artifacts,
            activityCollapsed: true,
            activity: currentActivity
              ? {
                ...currentActivity,
                status: result.status === 'ok' ? 'done' : result.status === 'aborted' ? 'aborted' : 'failed',
                endedAt,
                durationMs: result.durationMs || endedAt - currentActivity.startedAt,
                taskBook: result.taskBook ?? currentActivity.taskBook,
                verificationHistory: result.verificationHistory ?? currentActivity.verificationHistory,
                verificationRunning: false,
                error: result.status === 'ok'
                  ? undefined
                  : result.status === 'aborted'
                    ? result.error || '本次运行已停止。'
                    : result.error || '本次运行未生成可展示的回复。',
                steps: currentActivity.steps.length > 0 ? currentActivity.steps : taskSteps,
              }
              : undefined,
          }
        }
        return next
      })
      void refreshSessions()
      void refreshProjects()
    } catch (e) {
      if (!appMountedRef.current) return
      deltaBuffer.clear()
      if ((e as Error).name === 'AbortError') {
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
                ? { ...last.activity, status: 'aborted', error: '本次运行已停止。', endedAt, durationMs: endedAt - last.activity.startedAt }
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
        const error = (e as Error).message
        if (last?.role === 'assistant' && !last.text) {
          const endedAt = Date.now()
          next[next.length - 1] = {
            ...last,
            text: '',
            activityCollapsed: true,
            activity: last.activity
              ? { ...last.activity, status: 'failed', error, endedAt, durationMs: endedAt - last.activity.startedAt }
              : undefined,
          }
        }
        return next
      })
    } finally {
      deltaBuffer.dispose()
      settleApprovalPrompt('deny')
      abortRef.current = null
      activeRunIdRef.current = null
      stopRequestedRunIdRef.current = null
      liveToolStepRef.current.clear()
      if (appMountedRef.current) setLoading(false)
    }
  }

  function stop() {
    settleApprovalPrompt('deny')
    const runId = activeRunIdRef.current
    if (!runId) {
      abortRef.current?.abort()
      return
    }
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
  return { send, stop }
}

function localMessageId(role: 'user' | 'assistant'): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `live-${role}-${uuid}`
}


function updateLastAssistantText(
  messages: ChatMessage[],
  update: (text: string) => string,
): ChatMessage[] {
  const last = messages[messages.length - 1]
  if (last?.role !== 'assistant') return messages
  const next = [...messages]
  next[next.length - 1] = { ...last, text: update(last.text) }
  return next
}
