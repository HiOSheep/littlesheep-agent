import { describe, expect, it } from 'vitest'
import type { ProjectMeta, SessionMeta } from '../api'
import { sortProjectsForSidebar, sortSessionsForSidebar } from './list-motion'


const sessions: SessionMeta[] = [
  {
    id: 'standalone-a',
    title: '独立 A',
    createdAt: 1,
    lastMessageAt: 1,
    mode: 'research',
    scope: 'standalone',
  },
  {
    id: 'standalone-b',
    title: '独立 B',
    createdAt: 2,
    lastMessageAt: 2,
    mode: 'research',
    scope: 'standalone',
  },
  {
    id: 'standalone-c',
    title: '独立 C',
    createdAt: 3,
    lastMessageAt: 3,
    mode: 'research',
    scope: 'standalone',
  },
]

const projects: ProjectMeta[] = [
  {
    id: 'project-a',
    name: 'A',
    path: 'D:/A',
    createdAt: '2026-08-30T00:00:00.000Z',
    lastActiveAt: '2026-08-30T00:00:00.000Z',
  },
  {
    id: 'project-b',
    name: 'B',
    path: 'D:/B',
    createdAt: '2026-08-30T00:00:00.000Z',
    lastActiveAt: '2026-08-29T00:00:00.000Z',
  },
]


describe('sidebar manual ordering', () => {
  it('keeps pinned and unpinned conversations as separate sorting boundaries', () => {
    expect(sortSessionsForSidebar(
      sessions,
      new Set(['standalone-a']),
      ['standalone-c', 'standalone-b', 'standalone-a'],
    ).map((session) => session.id)).toEqual([
      'standalone-a',
      'standalone-c',
      'standalone-b',
    ])
  })

  it('uses manual project order only while the project mode is fixed', () => {
    expect(sortProjectsForSidebar(projects, 'fixed', ['project-b', 'project-a']).map((project) => project.id))
      .toEqual(['project-b', 'project-a'])
    expect(sortProjectsForSidebar(projects, 'recent', ['project-b', 'project-a']).map((project) => project.id))
      .toEqual(['project-a', 'project-b'])
  })
})
