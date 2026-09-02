// Runtime refresh and model-patch actions used by the top-level app controller.
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { getRuntime, updateRuntime, type RuntimePatch, type RuntimeState } from '../api'
import { splitModelRef } from '../composer/runtime-picker'

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
}

export function createRuntimeActions(options: RuntimeActionOptions) {
  async function refreshRuntime() {
    try {
      const next = await getRuntime()
      if (!options.appMountedRef.current) return
      options.setRuntime(next)
      options.setRuntimeError(null)
      options.alignWorkspacePanelToWorkspaceRoot(next.workspace)
    } catch (error) {
      if (options.appMountedRef.current) options.setRuntimeError((error as Error).message)
    }
  }

  async function applyRuntimePatch(patch: RuntimePatch): Promise<boolean> {
    try {
      const next = await updateRuntime(patch)
      if (!options.appMountedRef.current) return false
      options.setRuntime(next)
      options.setRuntimeError(null)
      if (Object.prototype.hasOwnProperty.call(patch, 'workspace')) options.alignWorkspacePanelToWorkspaceRoot(next.workspace)
      void options.refreshProjects()
      await options.notifyRuntimeSettingChanges(patch, next)
      return true
    } catch (error) {
      if (!options.appMountedRef.current) return false
      options.setRuntimeError((error as Error).message)
      await refreshRuntime()
      return false
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
      options.setRuntime(next)
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
      options.setRuntime(latest.baseline)
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
    if (!provider || !provider.models.includes(model)) return null
    return { provider, model, ref: options.runtime.model }
  }

  return { refreshRuntime, applyRuntimePatch, applyModelPatch, selectableProviders, selectedModel }
}
