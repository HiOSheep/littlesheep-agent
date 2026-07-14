// Extension workspace panels, files, terminal, artifacts, and view helpers.
import {
type TerminalActivityRecord,
type WorkspaceArtifactRecord
} from '../api'
import { formatDurationMs } from '../chat/activity-model'
import { shortActivityText } from '../chat/task-progress-indicator'
import { AssistantTurnStatus,ChatMessage } from '../chat/types'
import { fileActionLabel } from '../composer/message-files'
import { compactPath,normalizePathForCompare } from './path-utils'
import { terminalActivityStatus } from './terminal'
import { WorkspaceActivityFeedItem,WorkspaceArtifactRef } from './types'


export function collectWorkspaceArtifacts(messages: ChatMessage[]): WorkspaceArtifactRef[] {
  const byPath = new Map<string, WorkspaceArtifactRef>()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const artifacts = messages[index]?.artifacts ?? []
    for (const artifact of artifacts) {
      const key = normalizePathForCompare(artifact.path)
      if (!key || byPath.has(key)) continue
      byPath.set(key, artifact)
    }
  }
  return Array.from(byPath.values()).slice(0, 12)
}


export function workspaceArtifactRecordToRef(record: WorkspaceArtifactRecord): WorkspaceArtifactRef {
  return {
    path: record.path,
    name: record.name,
    action: record.action,
    toolName: record.toolName,
  }
}


export function mergeWorkspaceArtifacts(artifacts: WorkspaceArtifactRef[]): WorkspaceArtifactRef[] {
  const byPath = new Map<string, WorkspaceArtifactRef>()
  for (const artifact of artifacts) {
    const key = normalizePathForCompare(artifact.path)
    if (!key || byPath.has(key)) continue
    byPath.set(key, artifact)
  }
  return Array.from(byPath.values()).slice(0, 12)
}


export function buildWorkspaceActivityFeed(
  messages: ChatMessage[],
  terminalActivities: TerminalActivityRecord[],
  indexedArtifacts: WorkspaceArtifactRecord[] = [],
): WorkspaceActivityFeedItem[] {
  const items: WorkspaceActivityFeedItem[] = []

  messages.forEach((message, index) => {
    const fallbackTimestamp = parseMessageTimestamp(message, index)
    if (message.role === 'assistant' && message.activity) {
      const activity = message.activity
      const timestamp = activity.endedAt ?? activity.startedAt ?? fallbackTimestamp
      const stepCount = activity.steps.length
      const toolCount = activity.tools.length
      const duration = formatDurationMs(activity.durationMs ?? Math.max(0, (activity.endedAt ?? timestamp) - activity.startedAt))
      items.push({
        id: `agent:${index}:${timestamp}`,
        kind: 'agent',
        title: workspaceActivityStatusLabel(activity.status),
        detail: `${stepCount} 个步骤 · ${toolCount} 个工具 · ${duration}`,
        timestamp,
        status: activity.status,
      })
    }

    for (const artifact of message.artifacts ?? []) {
      items.push({
        id: `artifact:${index}:${artifact.action}:${artifact.path}`,
        kind: 'artifact',
        title: `${fileActionLabel(artifact.action)} ${artifact.name}`,
        detail: compactPath(artifact.path),
        timestamp: fallbackTimestamp,
        artifact,
      })
    }
  })

  const indexedArtifactKeys = new Set(items
    .filter((item) => item.kind === 'artifact' && item.artifact)
    .map((item) => normalizePathForCompare(item.artifact!.path)))
  for (const artifact of indexedArtifacts) {
    const key = normalizePathForCompare(artifact.path)
    if (!key || indexedArtifactKeys.has(key)) continue
    indexedArtifactKeys.add(key)
    items.push({
      id: `indexed-artifact:${artifact.id}`,
      kind: 'artifact',
      title: `${fileActionLabel(artifact.action)} ${artifact.name}`,
      detail: `${artifact.source === 'user' ? '用户保存' : 'Agent 产物'} · ${compactPath(artifact.path)}`,
      timestamp: Date.parse(artifact.createdAt),
      artifact: workspaceArtifactRecordToRef(artifact),
    })
  }

  for (const activity of terminalActivities) {
    const timestamp = Date.parse(activity.endedAt)
    items.push({
      id: `terminal:${activity.id}`,
      kind: 'terminal',
      title: `终端 · ${shortActivityText(activity.command, 48)}`,
      detail: `${terminalActivityStatus(activity)} · ${formatDurationMs(activity.durationMs)}`,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      status: terminalActivityStatus(activity),
    })
  }

  return items
    .filter((item) => Number.isFinite(item.timestamp))
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, 14)
}


export function workspaceActivitySearchText(item: WorkspaceActivityFeedItem): string {
  return [
    item.kind,
    item.title,
    item.detail,
    item.status,
    item.artifact?.name,
    item.artifact?.path,
    item.artifact?.toolName,
  ].filter(Boolean).join(' ').toLowerCase()
}


export function parseMessageTimestamp(message: ChatMessage, fallbackIndex: number): number {
  const parsed = message.timestamp ? Date.parse(message.timestamp) : NaN
  return Number.isFinite(parsed) ? parsed : fallbackIndex
}


export function workspaceActivityStatusLabel(status: AssistantTurnStatus): string {
  if (status === 'running') return 'Agent 正在执行'
  if (status === 'failed') return 'Agent 执行失败'
  if (status === 'aborted') return 'Agent 已停止'
  return 'Agent 完成一轮任务'
}
