// Renderer orchestration for startup checkpoint discovery and streamed continuation.

import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import {
  abandonRunCheckpoint,
  inspectRunCheckpoint,
  listRunCheckpoints,
  resumeRunCheckpointStream,
  sendRuntimeControlEvent,
  type ApprovalRequest,
  type RuntimeState,
  type SessionMeta,
} from '../api'
import type {
  LocalAppRunCheckpointDetail,
  LocalAppRunCheckpointDiagnostics,
  LocalAppRunCheckpointSummary,
} from '../../shared/run-checkpoint-contracts'
import { sessionApprovalScopeKey, type ApprovalDecision } from '../approval-grants'
import type { PermissionModeId } from '../../shared/permission-modes'
import { buildContextUsageSnapshot, type ContextUsageSnapshot } from '../context-usage'
import {
  checkpointRecoveryProgressForEvent,
  INITIAL_CHECKPOINT_RECOVERY_PROGRESS,
  type CheckpointRecoveryProgress,
} from './checkpoint-recovery-state'
import {
  resolveCheckpointRecoveryTurnIdentity,
  type CheckpointRecoveryTurnIdentity,
} from './checkpoint-recovery-request'

type RecoveryBusyState = 'loading' | 'inspecting' | 'abandoning' | 'resuming' | null

export interface UseCheckpointRecoveryOptions {
  abortRef: MutableRefObject<AbortController | null>
  activeRunIdRef: MutableRefObject<string | null>
  appMountedRef: MutableRefObject<boolean>
  loading: boolean
  getSessionPermissionMode: (sessionId: string) => PermissionModeId
  runtime: RuntimeState | null
  stopRequestedRunIdRef: MutableRefObject<string | null>
  refreshProjects: () => Promise<void>
  refreshSessions: () => Promise<SessionMeta[]>
  requestApprovalForScope: (request: ApprovalRequest, scopeKey: string) => Promise<boolean>
  settleApprovalPrompt: (decision: ApprovalDecision) => void
  switchSession: (session: SessionMeta, options?: { forceReload?: boolean }) => Promise<void>
  setActivityNow: Dispatch<SetStateAction<number>>
  setContextUsageSnapshot: Dispatch<SetStateAction<ContextUsageSnapshot | null>>
  setLoading: Dispatch<SetStateAction<boolean>>
  setWorkspaceArtifactVersion: Dispatch<SetStateAction<number>>
}

export function useCheckpointRecovery(options: UseCheckpointRecoveryOptions) {
  const {
    abortRef,
    activeRunIdRef,
    appMountedRef,
    getSessionPermissionMode,
    loading,
    runtime,
    stopRequestedRunIdRef,
    refreshProjects,
    refreshSessions,
    requestApprovalForScope,
    settleApprovalPrompt,
    switchSession,
    setActivityNow,
    setContextUsageSnapshot,
    setLoading,
    setWorkspaceArtifactVersion,
  } = options
  const [checkpoints, setCheckpoints] = useState<LocalAppRunCheckpointSummary[]>([])
  const [diagnostics, setDiagnostics] = useState<LocalAppRunCheckpointDiagnostics>({ invalidFiles: 0, warningCount: 0 })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<LocalAppRunCheckpointDetail | null>(null)
  const [visible, setVisible] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [busy, setBusy] = useState<RecoveryBusyState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [clarificationText, setClarificationText] = useState('')
  const [progress, setProgress] = useState<CheckpointRecoveryProgress>(INITIAL_CHECKPOINT_RECOVERY_PROGRESS)
  const [stopRequested, setStopRequested] = useState(false)
  const inspectionRequestRef = useRef(0)
  const pendingRecoveryTurnRef = useRef<CheckpointRecoveryTurnIdentity | null>(null)
  const startupRecoveryAttemptedRef = useRef(false)

  useEffect(() => {
    void refreshCheckpoints(false)
  }, [])

  useEffect(() => {
    if (startupRecoveryAttemptedRef.current || checkpoints.length === 0 || loading) return
    const checkpoint = checkpoints.find((item) => item.resumable && !item.waitingForInput)
    if (!checkpoint) return
    startupRecoveryAttemptedRef.current = true
    void resumeSelected(checkpoint)
  }, [checkpoints, loading])

  const selected = checkpoints.find((item) => item.id === selectedId) ?? checkpoints[0] ?? null

  async function refreshCheckpoints(
    openWhenPending: boolean,
    options: { preserveBusy?: boolean; preserveError?: boolean } = {},
  ): Promise<LocalAppRunCheckpointSummary[]> {
    const preserveBusy = options.preserveBusy === true
    if (!preserveBusy) setBusy('loading')
    if (!options.preserveError) setError(null)
    try {
      const response = await listRunCheckpoints()
      if (!appMountedRef.current) return []
      setCheckpoints(response.checkpoints)
      setDiagnostics(response.diagnostics)
      setSelectedId((current) => (
        current && response.checkpoints.some((item) => item.id === current)
          ? current
          : response.checkpoints[0]?.id ?? null
      ))
      setDetail((current) => (
        current && response.checkpoints.some((item) => item.id === current.id) ? current : null
      ))
      if (openWhenPending && response.checkpoints.length > 0) setVisible(true)
      if (response.checkpoints.length === 0) {
        setVisible(false)
        setDetailsOpen(false)
      }
      return response.checkpoints
    } catch (cause) {
      if (appMountedRef.current) setError((cause as Error).message)
      return []
    } finally {
      if (appMountedRef.current && !preserveBusy) setBusy(null)
    }
  }

  async function toggleDetails() {
    const nextOpen = !detailsOpen
    setDetailsOpen(nextOpen)
    if (!nextOpen || !selected || detail?.id === selected.id) return
    const requestId = ++inspectionRequestRef.current
    setBusy('inspecting')
    setError(null)
    try {
      const next = await inspectRunCheckpoint(selected.id)
      if (!appMountedRef.current || requestId !== inspectionRequestRef.current) return
      setDetail(next)
    } catch (cause) {
      if (appMountedRef.current && requestId === inspectionRequestRef.current) setError((cause as Error).message)
    } finally {
      if (appMountedRef.current && requestId === inspectionRequestRef.current) setBusy(null)
    }
  }

  function selectCheckpoint(checkpointId: string) {
    inspectionRequestRef.current += 1
    pendingRecoveryTurnRef.current = null
    setSelectedId(checkpointId)
    setDetail(null)
    setDetailsOpen(false)
    setClarificationText('')
    setError(null)
  }

  async function abandonSelected() {
    if (!selected || busy || loading) return
    setBusy('abandoning')
    setError(null)
    try {
      await abandonRunCheckpoint(selected.id)
      pendingRecoveryTurnRef.current = null
      await refreshCheckpoints(false, { preserveBusy: true })
    } catch (cause) {
      if (appMountedRef.current) setError((cause as Error).message)
    } finally {
      if (appMountedRef.current) setBusy(null)
    }
  }

  async function resumeSelected(checkpoint = selected) {
    if (!checkpoint || busy || loading || !checkpoint.resumable) return
    const clarification = clarificationText.trim()
    if (checkpoint.waitingForInput && !clarification) {
      setError('这个任务正在等待补充信息，请填写后再继续。')
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    activeRunIdRef.current = null
    stopRequestedRunIdRef.current = null
    setBusy('resuming')
    setLoading(true)
    setActivityNow(Date.now())
    setError(null)
    setProgress(INITIAL_CHECKPOINT_RECOVERY_PROGRESS)
    setStopRequested(false)
    const recoveryPermissionMode = getSessionPermissionMode(checkpoint.sessionId)
    const turnIdentity = resolveCheckpointRecoveryTurnIdentity(pendingRecoveryTurnRef.current, {
      checkpointId: checkpoint.id,
      text: clarification,
      permissionMode: recoveryPermissionMode,
      reasoning: runtime?.reasoning,
      profile: runtime?.profile,
    })
    pendingRecoveryTurnRef.current = turnIdentity
    try {
      const result = await resumeRunCheckpointStream(checkpoint.id, {
        ...(clarification ? { text: clarification } : {}),
        reason: 'user resumed checkpoint from the desktop recovery control',
        permissionMode: recoveryPermissionMode,
        reasoning: runtime?.reasoning,
        profile: runtime?.profile,
        requestKey: turnIdentity.requestKey,
        continuationDirective: 'answer',
      }, {
        signal: controller.signal,
        onStart: ({ runId }) => { activeRunIdRef.current = runId },
        onDelta: () => setProgress((current) => (
          current.phase === 'finalizing' ? current : { phase: 'finalizing', label: '正在整理交付结果' }
        )),
        onReplace: () => setProgress({ phase: 'finalizing', label: '正在整理交付结果' }),
        onToolEvent: (event) => setProgress((current) => checkpointRecoveryProgressForEvent(event, current)),
        onApprovalRequest: (request) => appMountedRef.current
          ? requestApprovalForScope(request, sessionApprovalScopeKey(checkpoint.sessionId))
          : Promise.resolve(false),
      })
      if (pendingRecoveryTurnRef.current?.requestKey === turnIdentity.requestKey) {
        pendingRecoveryTurnRef.current = null
      }
      if (!appMountedRef.current) return
      setContextUsageSnapshot(buildContextUsageSnapshot(
        runtime?.model,
        result.usage,
        result.contextSnapshots,
        result.modelRequests,
      ))
      setWorkspaceArtifactVersion((value) => value + 1)
      const nextSessions = await refreshSessions()
      const recoveredSession = nextSessions.find((session) => session.id === result.sessionId)
      if (recoveredSession) await switchSession(recoveredSession, { forceReload: true })
      void refreshProjects()
      if (result.status === 'ok') {
        await refreshCheckpoints(false, { preserveBusy: true })
        setVisible(false)
      } else {
        setError(result.error || (result.status === 'aborted' ? '恢复已停止，新的现场已保留。' : '恢复未完成，新的现场已保留。'))
        await refreshCheckpoints(!startupRecoveryAttemptedRef.current, { preserveBusy: true, preserveError: true })
      }
    } catch (cause) {
      if (
        ((cause as Error).name === 'AbortError' || (cause as Error).name === 'RunStreamServerError')
        && pendingRecoveryTurnRef.current?.requestKey === turnIdentity.requestKey
      ) {
        pendingRecoveryTurnRef.current = null
      }
      if (!appMountedRef.current) return
      setError((cause as Error).name === 'AbortError'
        ? '恢复已停止，现场仍然保留。'
        : (cause as Error).message)
      await refreshCheckpoints(!startupRecoveryAttemptedRef.current, { preserveBusy: true, preserveError: true })
    } finally {
      settleApprovalPrompt('deny')
      abortRef.current = null
      activeRunIdRef.current = null
      stopRequestedRunIdRef.current = null
      if (appMountedRef.current) {
        setStopRequested(false)
        setBusy(null)
        setLoading(false)
      }
    }
  }

  function stopRecovery() {
    if (stopRequested) return
    setStopRequested(true)
    const runId = activeRunIdRef.current
    if (!runId) {
      abortRef.current?.abort()
      return
    }
    if (stopRequestedRunIdRef.current === runId) return
    stopRequestedRunIdRef.current = runId
    void sendRuntimeControlEvent(runId, 'interrupt_requested', 'user-stopped-checkpoint-recovery')
      .then((outcome) => {
        if (outcome.kind === 'rejected') abortRef.current?.abort()
      })
      .catch(() => abortRef.current?.abort())
  }

  return {
    checkpoints,
    diagnostics,
    selected,
    detail,
    visible,
    detailsOpen,
    busy,
    error,
    clarificationText,
    progress,
    stopRequested,
    open: () => setVisible(true),
    dismiss: () => setVisible(false),
    selectCheckpoint,
    setClarificationText,
    toggleDetails,
    abandonSelected,
    resumeSelected,
    stopRecovery,
  }
}

export type CheckpointRecoveryController = ReturnType<typeof useCheckpointRecovery>
