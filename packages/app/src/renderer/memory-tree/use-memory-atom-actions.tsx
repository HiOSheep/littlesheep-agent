import { useEffect, useRef, useState } from 'react'
import type { MemoryAtomManagementAction, MemoryTreeNodeOverview, MemoryTreeOverview } from '../api'
import { exportMemoryAtom, manageMemoryAtom } from '../api'
import { MemoryAtomManagementDialog, type MemoryAtomDialogRequest } from './atom-actions'

export function useMemoryAtomActions({
  overview,
  onReload,
  onError,
}: {
  overview: MemoryTreeOverview | null
  onReload: () => Promise<void>
  onError: (message: string | null) => void
}) {
  const [request, setRequest] = useState<MemoryAtomDialogRequest | null>(null)
  const [visible, setVisible] = useState(false)
  const [busyNodeId, setBusyNodeId] = useState<string | null>(null)
  const timerRef = useRef(0)
  const frameRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => () => {
    mountedRef.current = false
    window.clearTimeout(timerRef.current)
    window.cancelAnimationFrame(frameRef.current)
  }, [])

  function open(node: MemoryTreeNodeOverview, action: MemoryAtomManagementAction) {
    window.clearTimeout(timerRef.current)
    window.cancelAnimationFrame(frameRef.current)
    setRequest({ node, action })
    setVisible(false)
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = window.requestAnimationFrame(() => {
        if (mountedRef.current) setVisible(true)
      })
    })
  }

  function close() {
    if (busyNodeId) return
    setVisible(false)
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      if (mountedRef.current) setRequest(null)
    }, 220)
  }

  async function submit(target: MemoryTreeNodeOverview | undefined, reason: string) {
    if (!request?.node.atomRevision) return
    setBusyNodeId(request.node.id)
    onError(null)
    try {
      const base = { atomId: request.node.id, expectedRevision: request.node.atomRevision, reason }
      if (request.action === 'move') {
        await manageMemoryAtom({ ...base, action: 'move', parentNodeId: target?.id })
      } else if (request.action === 'merge') {
        if (!target?.atomRevision) throw new Error('请选择具有有效 revision 的目标原子。')
        await manageMemoryAtom({
          ...base,
          action: 'merge',
          targetAtomId: target.id,
          targetExpectedRevision: target.atomRevision,
        })
      } else {
        await manageMemoryAtom({ ...base, action: request.action })
      }
      if (!mountedRef.current) return
      setVisible(false)
      setRequest(null)
      await onReload()
    } catch (error) {
      if (mountedRef.current) onError((error as Error).message)
    } finally {
      if (mountedRef.current) setBusyNodeId(null)
    }
  }

  async function exportAtom(node: MemoryTreeNodeOverview) {
    setBusyNodeId(node.id)
    onError(null)
    try {
      await exportMemoryAtom(node.id)
    } catch (error) {
      if (mountedRef.current) onError((error as Error).message)
    } finally {
      if (mountedRef.current) setBusyNodeId(null)
    }
  }

  return {
    busyNodeId,
    open,
    exportAtom,
    dialog: request && overview ? (
      <MemoryAtomManagementDialog
        request={request}
        nodes={overview.nodes}
        visible={visible}
        busy={busyNodeId === request.node.id}
        onClose={close}
        onSubmit={(target, reason) => { void submit(target, reason) }}
      />
    ) : null,
  }
}
