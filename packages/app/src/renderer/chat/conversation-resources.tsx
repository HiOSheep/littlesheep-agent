import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AttachmentRef } from '../api'
import type { WorkspaceReviewSnapshot } from '../../shared/workspace-review-contracts'
import { artifactIdentity, buildArtifactsFromLiveTools } from './activity-model'
import type { ChatMessage } from './types'
import { attachmentToArtifact, lastPathSegment } from '../workspace/path-utils'
import { workspaceReviewCache } from '../workspace/review-cache'
import { FadePresence } from '../ui/presence'
import { ConversationResourcesIcon, FileGlyphIcon, WorkspaceFeatureIcon } from '../ui/icons'
import type { WorkspaceArtifactRef } from '../workspace/types'

// Deliberately longer than the panel's slide transition (320ms):
// this is the unmount deadline, so it must outlast the retract rather than match it.
const RESOURCES_PANEL_MOTION_MS = 380

export function conversationResources(messages: readonly ChatMessage[], attachments: readonly AttachmentRef[]) {
  const outputs = new Map<string, WorkspaceArtifactRef>()
  const sources = new Map<string, WorkspaceArtifactRef>()
  for (const message of messages) {
    for (const file of [...message.artifacts ?? [], ...buildArtifactsFromLiveTools(message.activity?.tools) ?? []]) {
      if (file.action === 'attached') sources.set(artifactIdentity(file.path), file)
      else outputs.set(artifactIdentity(file.path), file)
    }
    for (const file of message.attachments ?? []) sources.set(artifactIdentity(file.path), attachmentToArtifact(file))
  }
  for (const file of attachments) sources.set(artifactIdentity(file.path), attachmentToArtifact(file))
  return { outputs: [...outputs.values()], sources: [...sources.values()] }
}

export function ConversationResources({ messages, attachments, root, version, collapsed, onOpenFile, onOpenReview }: {
  messages: readonly ChatMessage[]
  attachments: readonly AttachmentRef[]
  root: string
  version: number
  collapsed: boolean
  onOpenFile: (path: string) => void
  onOpenReview: () => void
}) {
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)
  const [panelWidth, setPanelWidth] = useState(320)
  const id = useId()
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const resources = useMemo(() => conversationResources(messages, attachments), [messages, attachments])
  useEffect(() => {
    if (!open) return
    const chat = container.current?.parentElement
    if (!chat) return
    const update = () => setPanelWidth(Math.max(120, Math.min(320, chat.clientWidth - (collapsed ? 48 : 10) - 10)))
    const observer = new ResizeObserver(update)
    observer.observe(chat); update()
    return () => observer.disconnect()
  }, [open, collapsed])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])
  const act = (action: () => void) => { setOpen(false); action() }
  return <div ref={container} className="conversation-resources" data-workspace-collapsed={collapsed}
    onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus() } }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <button ref={trigger} type="button" className="conversation-resources-toggle" aria-label="对话文件与来源" aria-expanded={open} aria-controls={id}
      onClick={() => { setAll(false); setOpen(!open) }}>
      <ConversationResourcesIcon />
    </button>
    <FadePresence show={open} exitMs={RESOURCES_PANEL_MOTION_MS} className="conversation-resources-presence">
      <section id={id} className="conversation-resources-panel" style={{ width: panelWidth }} aria-label="对话文件与来源">
        <div className="conversation-resources-title">{lastPathSegment(root) || '当前对话'}</div>
        <ResourceChanges root={root} version={version} onOpen={() => act(onOpenReview)} />
        {(['outputs', 'sources'] as const).map(kind => <section key={kind} className="conversation-resources-section">
          <div className="conversation-resources-heading"><span>{kind === 'outputs' ? '产物' : '来源'}</span>
          </div>
          {resources[kind].length ? (all ? resources[kind] : resources[kind].slice(-3)).map(file => <button key={artifactIdentity(file.path)} type="button" className="conversation-resources-file" onClick={() => act(() => onOpenFile(file.path))}>
            <FileGlyphIcon name={file.name} /><span>{file.name}</span>
          </button>) : <p>{kind === 'outputs' ? '暂无产物' : '暂无来源'}</p>}
        </section>)}
        {(resources.outputs.length > 3 || resources.sources.length > 3) && <button type="button" className="conversation-resources-all" onClick={() => setAll(!all)}>{all ? '收起列表' : `查看全部 ${resources.outputs.length + resources.sources.length} 个文件`}</button>}
      </section>
    </FadePresence>
  </div>
}

function ResourceChanges({ root, version, onOpen }: { root: string; version: number; onOpen: () => void }) {
  const [snapshot, setSnapshot] = useState<WorkspaceReviewSnapshot | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setSnapshot(null); setError('')
    if (!root) return
    workspaceReviewCache.loadSnapshot(root, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setSnapshot(value)
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取变更失败') })
    return () => controller.abort()
  }, [root, version])
  return <div className="conversation-resources-changes">
    <button type="button" onClick={onOpen}><WorkspaceFeatureIcon id="review" /><strong>变更</strong>
      {snapshot?.availability === 'ready' && <span className="conversation-resources-counts"><span>+{snapshot.additions}</span><span>−{snapshot.deletions}</span></span>}
    </button>
    {(error || !snapshot || snapshot.availability !== 'ready' || !snapshot.countsComplete || snapshot.filesTruncated || snapshot.unstable) && <p role="status">{error || (!root ? '未选择工作区' : !snapshot ? '正在读取变更…' : snapshot.availability === 'not-repository' ? '当前工作区不是 Git 仓库' : snapshot.availability !== 'ready' ? snapshot.message || '变更暂不可用' : '变更统计不完整，请打开变更查看详情')}</p>}
  </div>
}
