import { useEffect, useMemo, useRef, useState } from 'react'
import type { MemoryAtomManagementAction, MemoryTreeNodeOverview } from '../api'
import { MoreIcon } from '../ui/icons'

export function MemoryAtomActions({
  node,
  enabled,
  busy,
  onRequest,
  onExport,
}: {
  node: MemoryTreeNodeOverview
  enabled: boolean
  busy: boolean
  onRequest: (action: MemoryAtomManagementAction) => void
  onExport: () => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', escape)
    }
  }, [open])

  if (!enabled) return null
  const invoke = (action: MemoryAtomManagementAction) => {
    setOpen(false)
    onRequest(action)
  }
  return (
    <div className={`memory-atom-actions ${open ? 'open' : ''}`} ref={rootRef}>
      <button
        className="memory-atom-more"
        type="button"
        aria-label="更多记忆操作"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreIcon />
      </button>
      <div className="memory-atom-menu" role="menu" aria-hidden={!open}>
        {!node.mergedIntoId && <>
          <button type="button" role="menuitem" onClick={() => invoke('move')}>移动到其他层级</button>
          {!node.invalidatedAt && <button type="button" role="menuitem" onClick={() => invoke('merge')}>合并重复原子</button>}
          <span className="memory-atom-menu-separator" />
          <button type="button" role="menuitem" onClick={() => invoke(node.invalidatedAt ? 'reactivate' : 'invalidate')}>
            {node.invalidatedAt ? '恢复有效性' : '标记为失效'}
          </button>
        </>}
        <button type="button" role="menuitem" onClick={() => { setOpen(false); onExport() }}>导出证据包</button>
      </div>
    </div>
  )
}

export interface MemoryAtomDialogRequest {
  action: MemoryAtomManagementAction
  node: MemoryTreeNodeOverview
}

export function MemoryAtomManagementDialog({
  request,
  nodes,
  visible,
  busy,
  onClose,
  onSubmit,
}: {
  request: MemoryAtomDialogRequest
  nodes: MemoryTreeNodeOverview[]
  visible: boolean
  busy: boolean
  onClose: () => void
  onSubmit: (target: MemoryTreeNodeOverview | undefined, reason: string) => void
}) {
  const [query, setQuery] = useState('')
  const [targetId, setTargetId] = useState<string | null>(request.action === 'move' ? '__root__' : null)
  const [reason, setReason] = useState(defaultReason(request.action))
  const requiresTarget = request.action === 'move' || request.action === 'merge'
  const candidates = useMemo(() => nodes
    .filter((node) => node.id !== request.node.id && sameBoundary(node, request.node))
    .filter((node) => request.action !== 'merge' || (node.parentNodeId ?? '') === (request.node.parentNodeId ?? ''))
    .filter((node) => !node.mergedIntoId && !node.invalidatedAt)
    .filter((node) => !query.trim() || `${node.summary}\n${node.retrievalKeys.join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((left, right) => left.summary.localeCompare(right.summary)), [nodes, query, request])
  const target = targetId && targetId !== '__root__' ? nodes.find((node) => node.id === targetId) : undefined
  const canSubmit = Boolean(reason.trim()) && (!requiresTarget || request.action === 'move' || target)
  const copy = dialogCopy(request.action)

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [busy, onClose])

  return (
    <div className={`memory-atom-dialog-layer ${visible ? 'visible' : ''}`}>
      <button className="memory-confirmation-scrim" type="button" onClick={onClose} aria-label="关闭记忆操作窗口" disabled={busy} />
      <div className="memory-atom-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-atom-dialog-title">
        <h3 id="memory-atom-dialog-title">{copy.title}</h3>
        <p>{copy.description}</p>
        <blockquote>{request.node.summary}</blockquote>
        {requiresTarget && <div className="memory-atom-target-picker">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选目标记忆"
            aria-label="筛选目标记忆"
            autoFocus
          />
          <div className="memory-atom-target-list">
            {request.action === 'move' && (
              <button className={targetId === '__root__' ? 'selected' : ''} type="button" onClick={() => setTargetId('__root__')}>
                <strong>分支根层级</strong><small>移除当前 parent，但不改变 branch 或 scope</small>
              </button>
            )}
            {candidates.map((candidate) => (
              <button
                className={targetId === candidate.id ? 'selected' : ''}
                type="button"
                key={candidate.id}
                onClick={() => setTargetId(candidate.id)}
              >
                <strong>{candidate.summary}</strong>
                <small>T{candidate.tier} · r{candidate.atomRevision ?? 0}</small>
              </button>
            ))}
            {candidates.length === 0 && request.action === 'merge' && <p>当前层级没有可选择的兼容候选。</p>}
          </div>
        </div>}
        <label className="memory-atom-reason">
          <span>操作理由</span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={2000} />
        </label>
        <div className="memory-confirmation-actions">
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
          <button
            className={request.action === 'invalidate' ? 'danger' : 'primary'}
            type="button"
            disabled={busy || !canSubmit}
            onClick={() => onSubmit(target, reason.trim())}
          >
            {busy ? '处理中' : copy.confirm}
          </button>
        </div>
      </div>
    </div>
  )
}

function sameBoundary(left: MemoryTreeNodeOverview, right: MemoryTreeNodeOverview): boolean {
  return left.branch === right.branch
    && left.scope === right.scope
    && (left.scopeKey ?? '') === (right.scopeKey ?? '')
}

function defaultReason(action: MemoryAtomManagementAction): string {
  return ({
    move: '用户调整了记忆原子的层级位置。',
    merge: '用户确认两个原子属于同一项记忆投影。',
    invalidate: '当前原子不再适合参与检索和上下文装配。',
    reactivate: '原子的有效性已经重新确认。',
  })[action]
}

function dialogCopy(action: MemoryAtomManagementAction) {
  return ({
    move: { title: '移动记忆原子', description: '只调整投影层级，不会改写原始数据记录或跨越作用域。', confirm: '确认移动' },
    merge: { title: '合并重复原子', description: '目标保留稳定 ID；来源保留为可审计记录，不会提高置信度。', confirm: '确认合并' },
    invalidate: { title: '标记记忆失效', description: '原始数据记录继续保留，但该投影将退出检索和上下文装配。', confirm: '确认失效' },
    reactivate: { title: '恢复记忆有效性', description: '恢复失效前保存的认识状态和处理状态。', confirm: '确认恢复' },
  })[action]
}
