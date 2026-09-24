// Runtime refresh and model-patch actions used by the top-level app controller.
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { getRuntime, updateRuntime, type RuntimePatch, type RuntimeState } from '../api'
import { updateSessionWorkspace } from '../api/sessions'
import { splitModelRef } from '../composer/runtime-picker'
import type { SessionScope } from '../../shared/session-scope'

export type PendingModelPatch = {
  requestId: number
  patch: Pick<RuntimePatch, 'model' | 'reasoning'>
  baseline: RuntimeState
  inFlight: boolean
}

interface RuntimeActionOptions {
  appMountedRef: MutableRefObject<boolean>
  runtime: RuntimeState | null
  setRuntime: Dispatch<SetStateAction<RuntimeState | null>>
  setRuntimeError: Dispatch<SetStateAction<string | null>>
  alignWorkspacePanelToWorkspaceRoot: (root: string) => void
  notifyRuntimeSettingChanges: (patch: RuntimePatch, next: RuntimeState) => Promise<void>
  refreshProjects: () => Promise<void>
  modelPatchSequenceRef: MutableRefObject<number>
  pendingModelPatchRef: MutableRefObject<PendingModelPatch | null>
  selectedSessionWorkspaceRef: MutableRefObject<string | undefined>
  defaultWorkspaceRef: MutableRefObject<string | undefined>
}

export function createRuntimeActions(options: RuntimeActionOptions) {
  const forSelectedSession = (next: RuntimeState): RuntimeState => (
    options.selectedSessionWorkspaceRef.current
      ? { ...next, workspace: options.selectedSessionWorkspaceRef.current }
      : next
  )

  async function refreshRuntime() {
    try {
      const next = await getRuntime()
      if (!options.appMountedRef.current) return
      options.defaultWorkspaceRef.current = next.workspace
      options.setRuntime(forSelectedSession(next))
      options.setRuntimeError(null)
      options.alignWorkspacePanelToWorkspaceRoot(forSelectedSession(next).workspace)
    } catch (error) {
      if (options.appMountedRef.current) options.setRuntimeError((error as Error).message)
    }
  }

  async function applyRuntimePatch(patch: RuntimePatch): Promise<boolean> {
    return (await applyRuntimePatchReporting(patch)) === null
  }

  /**
   * Same transaction, but the failure text is also returned to the caller so a
   * settings page can show it where the change was made instead of leaving the
   * user to find it in the composer error line.
   */
  async function applyRuntimePatchReporting(patch: RuntimePatch): Promise<string | null> {
    try {
      const next = await updateRuntime(patch)
      if (!options.appMountedRef.current) return null
      options.defaultWorkspaceRef.current = next.workspace
      if (Object.prototype.hasOwnProperty.call(patch, 'workspace')) {
        options.selectedSessionWorkspaceRef.current = next.workspace
      }
      options.setRuntime(forSelectedSession(next))
      options.setRuntimeError(null)
      if (Object.prototype.hasOwnProperty.call(patch, 'workspace')) options.alignWorkspacePanelToWorkspaceRoot(next.workspace)
      void options.refreshProjects()
      await options.notifyRuntimeSettingChanges(patch, next)
      return null
    } catch (error) {
      if (!options.appMountedRef.current) return null
      const message = (error as Error).message
      options.setRuntimeError(message)
      await refreshRuntime()
      return message
    }
  }

  async function flushModelPatchQueue(): Promise<void> {
    const pending = options.pendingModelPatchRef.current
    if (!pending || pending.inFlight) return
    pending.inFlight = true
    const { requestId, patch } = pending
    try {
      const next = await updateRuntime(patch)
      if (!options.appMountedRef.current) return
      options.defaultWorkspaceRef.current = next.workspace
      void options.notifyRuntimeSettingChanges(patch, next)
      const latest = options.pendingModelPatchRef.current
      if (!latest || latest.requestId !== requestId) {
        if (latest) {
          latest.baseline = next
          latest.inFlight = false
          void flushModelPatchQueue()
        }
        return
      }
      options.pendingModelPatchRef.current = null
      options.setRuntime(forSelectedSession(next))
      options.setRuntimeError(null)
    } catch (error) {
      if (!options.appMountedRef.current) return
      const latest = options.pendingModelPatchRef.current
      if (!latest || latest.requestId !== requestId) {
        if (latest) {
          latest.inFlight = false
          void flushModelPatchQueue()
        }
        return
      }
      options.pendingModelPatchRef.current = null
      options.setRuntime(forSelectedSession(latest.baseline))
      options.setRuntimeError((error as Error).message)
    }
  }

  function applyModelPatch(patch: Pick<RuntimePatch, 'model' | 'reasoning'>): void {
    const currentRuntime = options.runtime
    if (!currentRuntime) {
      void applyRuntimePatch(patch)
      return
    }
    const requestId = ++options.modelPatchSequenceRef.current
    const pending = options.pendingModelPatchRef.current
    options.pendingModelPatchRef.current = {
      requestId,
      patch,
      baseline: pending?.baseline ?? currentRuntime,
      inFlight: pending?.inFlight ?? false,
    }
    options.setRuntime((current) => current ? { ...current, ...patch } : current)
    options.setRuntimeError(null)
    void flushModelPatchQueue()
  }

  function selectableProviders() {
    return options.runtime?.providers.filter((provider) => provider.models.length > 0 && (!provider.requiresKey || provider.hasKey)) ?? []
  }

  function selectedModel(providers: ReturnType<typeof selectableProviders>) {
    if (!options.runtime) return null
    const { providerId, model } = splitModelRef(options.runtime.model)
    const provider = providers.find((item) => item.id === providerId)
    if (!provider || !provider.models.some((candidate) => candidate.id === model)) return null
    return { provider, model, ref: options.runtime.model }
  }

  /**
   * Pick a directory for the current session.
   *
   * A project session runs where its project is, so saving the default alone
   * would not move it: the user's explicit pick is also this session's new
   * directory. A standalone session keeps following the default.
   */
  async function chooseWorkspacePath(input: {
    selectDirectory: () => Promise<string | null | undefined>
    sessionId?: string
    sessionScope: SessionScope
  }): Promise<void> {
    try {
      const path = await input.selectDirectory()
      if (!options.appMountedRef.current || !path) return
      if (input.sessionId && input.sessionScope === 'project') {
        await updateSessionWorkspace(input.sessionId, path)
      }
      await applyRuntimePatch({ workspace: path })
    } catch (error) {
      if (options.appMountedRef.current) options.setRuntimeError((error as Error).message)
    }
  }

  return {
    refreshRuntime,
    applyRuntimePatch,
    applyRuntimePatchReporting,
    applyModelPatch,
    chooseWorkspacePath,
    selectableProviders,
    selectedModel,
  }
}
