// Application-shell state helpers shared by the renderer composition root.
import { useLayoutEffect, useRef } from 'react'
import { standaloneSessions } from '../../shared/session-scope'
import {
  type ProjectMeta,
  type SessionMeta
} from '../api'
import { ProjectSortMode } from '../sidebar/types'
import { lastPathSegment } from '../workspace/path-utils'


export function useListReorderAnimation<T extends HTMLElement>(
  keys: string[],
  options: { duration?: number; easing?: string } = {},
) {
  const nodesRef = useRef(new Map<string, T>())
  const positionsRef = useRef(new Map<string, DOMRect>())
  const animationsRef = useRef(new Map<string, Animation>())
  const keySignature = keys.join('\u001f')
  const duration = options.duration ?? 240
  const easing = options.easing ?? 'cubic-bezier(0.22, 0.72, 0.2, 1)'

  useLayoutEffect(() => {
    // Cancel the previous FLIP pass before measuring. Otherwise getBoundingClientRect()
    // includes the old animation's transform and the next pass can chase a moving target.
    for (const animation of animationsRef.current.values()) animation.cancel()
    animationsRef.current.clear()

    const previous = positionsRef.current
    const next = new Map<string, DOMRect>()

    for (const key of keys) {
      const node = nodesRef.current.get(key)
      if (!node) continue
      const rect = node.getBoundingClientRect()
      const oldRect = previous.get(key)
      next.set(key, rect)
      if (!oldRect) continue
      const dx = oldRect.left - rect.left
      const dy = oldRect.top - rect.top
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
      const animation = node.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: 'translate(0, 0)' },
        ],
        {
          duration,
          easing,
        },
      )
      animationsRef.current.set(key, animation)
      void animation.finished.then(() => {
        if (animationsRef.current.get(key) === animation) animationsRef.current.delete(key)
      }).catch(() => {
        // Cancellation is expected when the pointer crosses another tab mid-animation.
      })
    }

    positionsRef.current = next
    return () => {
      for (const animation of animationsRef.current.values()) animation.cancel()
      animationsRef.current.clear()
    }
  }, [duration, easing, keySignature])

  return (key: string) => (node: T | null) => {
    if (node) {
      nodesRef.current.set(key, node)
    } else {
      nodesRef.current.delete(key)
    }
  }
}


export function formatRelativeSessionTime(timestamp: number, now: number): string {
  const diffMs = Math.max(0, now - timestamp)
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}分`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}月`
  return `${Math.floor(days / 365)}年`
}


export function sortSessionsForSidebar(
  sessions: SessionMeta[],
  pinnedIds: Set<string>,
  manualOrder: readonly string[] = [],
): SessionMeta[] {
  const rank = createOrderRank(manualOrder)
  return [...sessions].sort((left, right) => {
    const leftPinned = pinnedIds.has(left.id)
    const rightPinned = pinnedIds.has(right.id)
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1
    const manualComparison = compareManualOrder(left.id, right.id, rank)
    if (manualComparison !== null) return manualComparison
    return right.lastMessageAt - left.lastMessageAt
  })
}


export function sortProjectsForSidebar(
  projects: ProjectMeta[],
  mode: ProjectSortMode,
  manualOrder: readonly string[] = [],
): ProjectMeta[] {
  if (mode === 'fixed') return sortByManualOrder(projects, manualOrder)
  return [...projects].sort((left, right) => {
    if (mode === 'recent') {
      return Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt)
    }
    return (left.name || lastPathSegment(left.path)).localeCompare(
      right.name || lastPathSegment(right.path),
      'zh-Hans-CN',
      { sensitivity: 'base' },
    )
  })
}


export function standaloneSessionsForSidebar(sessions: SessionMeta[]): SessionMeta[] {
  return standaloneSessions(sessions)
}


export function mergeOrderedList<T>(preferred: readonly T[], fallback: readonly T[]): T[] {
  const seen = new Set<T>()
  const result: T[] = []
  for (const value of [...preferred, ...fallback]) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}


function sortByManualOrder<T extends { id: string }>(items: readonly T[], manualOrder: readonly string[]): T[] {
  if (manualOrder.length === 0) return [...items]
  const rank = createOrderRank(manualOrder)
  return [...items].sort((left, right) => compareManualOrder(left.id, right.id, rank) ?? 0)
}


function createOrderRank(order: readonly string[]): Map<string, number> {
  return new Map(order.map((id, index) => [id, index]))
}


function compareManualOrder(
  leftId: string,
  rightId: string,
  rank: Map<string, number>,
): number | null {
  const leftRank = rank.get(leftId)
  const rightRank = rank.get(rightId)
  if (leftRank === undefined && rightRank === undefined) return null
  if (leftRank === undefined) return 1
  if (rightRank === undefined) return -1
  return leftRank - rightRank
}
