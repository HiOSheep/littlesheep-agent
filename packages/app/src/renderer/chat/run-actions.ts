// Owns one streamed Agent run, its progress events, approval bridge, stop behavior, and final message reduction.
import '@xterm/xterm/css/xterm.css'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import {
  runAgentStream,
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
import { buildArtifactsFromToolCalls, buildTraceData, bumpLiveStepTools, mergeTaskBookIntoLiveSteps, taskStepToLiveStep, updateLastAssistantActivity, upsertLiveStep, upsertLiveTool } from './activity-model'
import { ChatMessage, LiveStepStatus } from './types'

export interface RunActionContext {
  abortRef: MutableRefObject<AbortController | null>
  activeApprovalScopeKey: (sessionId?: string) => string
  appMountedRef: MutableRefObject<boolean>
  approvalGrantsRef: MutableRefObject<SessionApprovalGrantStore>
  attachments: AttachmentRef[]
  currentSession: string | undefined
  input: string
  liveToolStepRef: MutableRefObject<Map<string, string>>
  loading: boolean
  permissionMode: PermissionModeId
  refreshProjects: () => Promise<void>
  refreshSessions: () => Promise<void>
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
}

export function createRunActions(context: RunActionContext) {
  const { abortRef, activeApprovalScopeKey, appMountedRef, approvalGrantsRef, attachments, currentSession, input, liveToolStepRef, loading, permissionMode, refreshProjects, refreshSessions, requestApprovalForScope, runtime, sessionOwnership, setActivityNow, setAttachments, setContextUsageSnapshot, setCurrentSession, setInput, setLoading, setMessages, setWorkspaceArtifactVersion, settleApprovalPrompt } = context


  async function send() {
    const text = input.trim()
    if ((!text && attachments.length === 0) || loading) return
    const activeAttachments = attachments
    const displayText = formatUserMessage(text, activeAttachments)
    const controller = new AbortController()
    const activityStartedAt = Date.now()
    const approvalScopeKey = activeApprovalScopeKey()
    abortRef.current = controller
    setInput('')
    setAttachments([])
    setActivityNow(activityStartedAt)
    setMessages((m) => [
      ...m,
      { role: 'user', text: displayText, timestamp: new Date(activityStartedAt).toISOString(), attachments: activeAttachments },
      {
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
    try {
      const result = await runAgentStream(text || '请根据附件继续处理。', currentSession, permissionMode, {
        signal: controller.signal,
        onApprovalRequest: (request) => appMountedRef.current
          ? requestApprovalForScope(request, approvalScopeKey)
          : Promise.resolve(false),
        onToolEvent: (evt) => {
          if (!appMountedRef.current) return
          if (evt.type === 'task_book' && evt.taskBook) {
            const taskBook = evt.taskBook
            updateLastAssistantActivity(setMessages, (activity) => ({
              ...activity,
              taskBook,
              steps: mergeTaskBookIntoLiveSteps(activity.steps, taskBook),
            }))
            return
          }
          if (evt.type === 'step_start' && evt.stepId) {
            updateLastAssistantActivity(setMessages, (activity) => ({
              ...activity,
              steps: upsertLiveStep(activity.steps, {
                stepId: evt.stepId ?? '',
                title: evt.title || evt.description || '执行步骤',
                description: evt.description,
                status: 'running',
                startedAt: Date.now(),
              }),
            }))
            return
          }
          if (evt.type === 'verification_start') {
            updateLastAssistantActivity(setMessages, (activity) => ({
              ...activity,
              verificationRunning: true,
            }))
            return
          }
          if (evt.type === 'verification' && evt.verification) {
            updateLastAssistantActivity(setMessages, (activity) => ({
              ...activity,
              verificationRunning: false,
              verificationHistory: [
                ...(activity.verificationHistory ?? []),
                evt.verification!,
              ],
            }))
            return
          }
          if (evt.type === 'step_done' || evt.type === 'step_failed' || evt.type === 'step_skipped') {
            if (!evt.stepId) return
            const status: LiveStepStatus = evt.type === 'step_done'
              ? 'done'
              : evt.type === 'step_failed'
                ? 'failed'
                : 'skipped'
            updateLastAssistantActivity(setMessages, (activity) => ({
              ...activity,
              steps: upsertLiveStep(activity.steps, {
                stepId: evt.stepId ?? '',
                title: evt.title || evt.description || '执行步骤',
                description: evt.description,
                status,
                output: evt.output,
                error: evt.error,
                activeTools: 0,
                endedAt: Date.now(),
              }),
            }))
            return
          }
          if (evt.type === 'tool_start' && evt.callId && evt.name) {
            if (evt.stepId) liveToolStepRef.current.set(evt.callId, evt.stepId)
            updateLastAssistantActivity(setMessages, (activity) => ({
              ...activity,
              tools: upsertLiveTool(activity.tools, {
                callId: evt.callId ?? '',
                name: evt.name ?? '',
                stepId: evt.stepId,
                startedAt: Date.now(),
                input: evt.input,
                ok: undefined,
                error: undefined,
              }),
              steps: evt.stepId ? bumpLiveStepTools(activity.steps, evt.stepId ?? '', 1) : activity.steps,
            }))
            return
          }
          if (evt.type === 'tool_end' && evt.callId) {
            const stepId = evt.stepId ?? liveToolStepRef.current.get(evt.callId)
            liveToolStepRef.current.delete(evt.callId)
            updateLastAssistantActivity(setMessages, (activity) => ({
              ...activity,
              tools: upsertLiveTool(activity.tools, {
                callId: evt.callId ?? '',
                name: evt.name ?? '',
                stepId,
                ok: evt.ok,
                output: evt.output,
                error: evt.error,
                endedAt: Date.now(),
              }),
              steps: stepId ? bumpLiveStepTools(activity.steps, stepId, -1) : activity.steps,
            }))
          }
        },
        onDelta: (delta) => {
          if (!appMountedRef.current) return
          if (!delta) return
          setMessages((m) => {
            const next = [...m]
            const last = next[next.length - 1]
            if (last?.role === 'assistant') {
              next[next.length - 1] = { ...last, text: last.text + delta }
            }
            return next
          })
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
            text: last.text || result.reply || '(no reply)',
            ...traceData,
            artifacts,
            activityCollapsed: true,
            activity: currentActivity
              ? {
                ...currentActivity,
                status: result.status === 'ok' ? 'done' : 'failed',
                endedAt,
                durationMs: result.durationMs || endedAt - currentActivity.startedAt,
                taskBook: result.taskBook ?? currentActivity.taskBook,
                verificationHistory: result.verificationHistory ?? currentActivity.verificationHistory,
                verificationRunning: false,
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
      if ((e as Error).name === 'AbortError') {
        setMessages((m) => {
          const next = [...m]
          const last = next[next.length - 1]
          if (last?.role === 'assistant') {
            const endedAt = Date.now()
            next[next.length - 1] = {
              ...last,
              text: last.text || '已停止。',
              activityCollapsed: true,
              activity: last.activity
                ? { ...last.activity, status: 'aborted', endedAt, durationMs: endedAt - last.activity.startedAt }
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
        const text = `Error: ${(e as Error).message}`
        if (last?.role === 'assistant' && !last.text) {
          const endedAt = Date.now()
          next[next.length - 1] = {
            ...last,
            text,
            activityCollapsed: true,
            activity: last.activity
              ? { ...last.activity, status: 'failed', endedAt, durationMs: endedAt - last.activity.startedAt }
              : undefined,
          }
        } else {
          next.push({ role: 'assistant', text })
        }
        return next
      })
    } finally {
      settleApprovalPrompt('deny')
      abortRef.current = null
      liveToolStepRef.current.clear()
      if (appMountedRef.current) setLoading(false)
    }
  }

  function stop() {
    settleApprovalPrompt('deny')
    abortRef.current?.abort()
  }
  return { send, stop }
}
