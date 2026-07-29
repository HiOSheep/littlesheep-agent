// Owns bounded Renderer feedback and non-message producers for active-run events.
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import {
  sendRuntimeTaskEvent,
  type RuntimePatch,
  type RuntimeState,
  type WorkspacePreview,
} from '../api'
import { workspaceBreadcrumbs } from '../workspace/path-utils'
import {
  createRuntimeTaskEventIdentity,
  describeRuntimeSettingBatch,
  describeRuntimeTaskEventFailure,
  describeRuntimeTaskEventOutcome,
  runtimeEventNoticeDurationMs,
  runtimeSettingEventEntries,
  type RuntimeTaskEventIdentity,
  type RuntimeTaskEventNotice,
} from './runtime-task-events'


export function useRuntimeTaskEvents({
  activeRunIdRef,
  appMountedRef,
  loading,
}: {
  activeRunIdRef: MutableRefObject<string | null>
  appMountedRef: MutableRefObject<boolean>
  loading: boolean
}) {
  const [runtimeEventNotice, setRuntimeEventNotice] = useState<RuntimeTaskEventNotice | null>(null)
  const pendingRuntimeMessageRef = useRef<{
    runId: string
    text: string
    identity: RuntimeTaskEventIdentity
  } | null>(null)
  const noticeTimerRef = useRef<number>()

  useEffect(() => () => window.clearTimeout(noticeTimerRef.current), [])

  function publishRuntimeEventNotice(notice: RuntimeTaskEventNotice | null) {
    window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = undefined
    if (!appMountedRef.current) return
    setRuntimeEventNotice(notice)
    if (!notice) return
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = undefined
      if (appMountedRef.current) {
        setRuntimeEventNotice((current) => current?.id === notice.id ? null : current)
      }
    }, runtimeEventNoticeDurationMs(notice.tone))
  }

  async function notifyRuntimeSettingChanges(patch: RuntimePatch, next: RuntimeState) {
    const runId = activeRunIdRef.current
    if (!loading || !runId) return
    const entries = runtimeSettingEventEntries(patch, next)
    if (entries.length === 0) return
    const settled = await Promise.allSettled(entries.map(({ key, value }) => {
      const identity = createRuntimeTaskEventIdentity(`setting-${key}`)
      return sendRuntimeTaskEvent(runId, {
        type: 'setting_changed',
        id: identity.id,
        dedupKey: identity.dedupKey,
        reason: 'renderer-setting-update',
        payload: { key, value },
      })
    }))
    if (!appMountedRef.current) return
    const outcomes: Array<Awaited<ReturnType<typeof sendRuntimeTaskEvent>>> = []
    const failures: unknown[] = []
    for (const item of settled) {
      if (item.status === 'fulfilled') outcomes.push(item.value)
      else failures.push(item.reason)
    }
    publishRuntimeEventNotice(describeRuntimeSettingBatch(outcomes, failures))
  }

  function notifyRuntimeWorkspaceFileSaved(root: string, path: string, preview: WorkspacePreview) {
    const runId = activeRunIdRef.current
    if (!loading || !runId) return
    const relativePath = workspaceBreadcrumbs(root, path).join('/') || preview.relativePath || preview.name
    const identity = createRuntimeTaskEventIdentity('workspace-file-saved')
    void sendRuntimeTaskEvent(runId, {
      type: 'workspace_file_saved',
      id: identity.id,
      dedupKey: identity.dedupKey,
      reason: 'renderer-workspace-save',
      payload: {
        path: relativePath,
        kind: preview.kind,
        size: preview.size,
        ...(preview.modifiedAt === undefined ? {} : { modifiedAt: preview.modifiedAt }),
      },
    }).then((outcome) => {
      if (appMountedRef.current) publishRuntimeEventNotice(describeRuntimeTaskEventOutcome('file', outcome))
    }).catch((error) => {
      if (appMountedRef.current) publishRuntimeEventNotice(describeRuntimeTaskEventFailure('file', error))
    })
  }

  return {
    runtimeEventNotice,
    pendingRuntimeMessageRef,
    publishRuntimeEventNotice,
    notifyRuntimeSettingChanges,
    notifyRuntimeWorkspaceFileSaved,
  }
}
