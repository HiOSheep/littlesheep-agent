// Validates and persists native window placement independently from BrowserWindow lifecycle code.

import { readFileSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWrite } from '@littlesheep/memory-core'

export interface DesktopWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DesktopWindowState {
  version: 1
  bounds: DesktopWindowBounds
  maximized: boolean
}

export interface DesktopWorkArea extends DesktopWindowBounds {}

const DESKTOP_WINDOW_STATE_VERSION = 1 as const
const DEFAULT_WINDOW_WIDTH = 1280
const DEFAULT_WINDOW_HEIGHT = 820
const MIN_WINDOW_WIDTH = 800
const MIN_WINDOW_HEIGHT = 600
const MAX_WINDOW_SIZE = 16_384
const WINDOW_STATE_MAX_BYTES = 64 * 1024

export function loadDesktopWindowState(
  filePath: string | undefined,
  workAreas: DesktopWorkArea[],
): DesktopWindowState | null {
  if (!filePath) return null
  try {
    if (statSync(filePath).size > WINDOW_STATE_MAX_BYTES) return null
    return hydrateDesktopWindowState(JSON.parse(readFileSync(filePath, 'utf8')) as unknown, workAreas)
  } catch {
    return null
  }
}

export async function saveDesktopWindowState(
  filePath: string | undefined,
  state: DesktopWindowState,
): Promise<void> {
  if (!filePath) return
  await mkdir(dirname(filePath), { recursive: true })
  await atomicWrite(filePath, JSON.stringify(state, null, 2))
}

export function hydrateDesktopWindowState(
  input: unknown,
  workAreas: DesktopWorkArea[],
): DesktopWindowState | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  if (value.version !== DESKTOP_WINDOW_STATE_VERSION) return null
  const bounds = normalizeBounds(value.bounds)
  const displays = workAreas.map(normalizeBounds).filter((area): area is DesktopWindowBounds => area !== null)
  if (!bounds || displays.length === 0) return null
  const workArea = selectWorkArea(bounds, displays)
  const width = clamp(bounds.width, Math.min(MIN_WINDOW_WIDTH, workArea.width), workArea.width)
  const height = clamp(bounds.height, Math.min(MIN_WINDOW_HEIGHT, workArea.height), workArea.height)
  return {
    version: DESKTOP_WINDOW_STATE_VERSION,
    bounds: {
      x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - width),
      y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - height),
      width,
      height,
    },
    maximized: value.maximized === true,
  }
}

export function createDesktopWindowState(
  bounds: DesktopWindowBounds,
  maximized: boolean,
): DesktopWindowState {
  return {
    version: DESKTOP_WINDOW_STATE_VERSION,
    bounds: normalizeBounds(bounds) ?? {
      x: 0,
      y: 0,
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
    },
    maximized,
  }
}

function normalizeBounds(input: unknown): DesktopWindowBounds | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Partial<DesktopWindowBounds>
  if (![value.x, value.y, value.width, value.height].every(Number.isFinite)) return null
  const width = clamp(Math.round(value.width!), 1, MAX_WINDOW_SIZE)
  const height = clamp(Math.round(value.height!), 1, MAX_WINDOW_SIZE)
  return {
    x: Math.round(value.x!),
    y: Math.round(value.y!),
    width,
    height,
  }
}

function selectWorkArea(bounds: DesktopWindowBounds, workAreas: DesktopWindowBounds[]): DesktopWindowBounds {
  return workAreas.reduce((best, candidate) => {
    const bestIntersection = intersectionArea(bounds, best)
    const candidateIntersection = intersectionArea(bounds, candidate)
    if (candidateIntersection !== bestIntersection) {
      return candidateIntersection > bestIntersection ? candidate : best
    }
    return centerDistanceSquared(bounds, candidate) < centerDistanceSquared(bounds, best)
      ? candidate
      : best
  })
}

function intersectionArea(left: DesktopWindowBounds, right: DesktopWindowBounds): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  return width * height
}

function centerDistanceSquared(left: DesktopWindowBounds, right: DesktopWindowBounds): number {
  const x = left.x + left.width / 2 - (right.x + right.width / 2)
  const y = left.y + left.height / 2 - (right.y + right.height / 2)
  return x * x + y * y
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}
