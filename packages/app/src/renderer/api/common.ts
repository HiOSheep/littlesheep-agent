// Shared renderer API transport helpers. Domain clients only depend on these
// helpers and the canonical route/contract modules.

import type { WindowDragPoint } from '../../shared/window-drag-contracts'

declare global {
  interface Window {
    littlesheep: {
      apiBase: string
      getPathForFile?: (file: unknown) => string
      onBrowserOpenNewTab?: (listener: (event: { url: string; disposition?: string }) => void) => () => void
      onApplicationStateFlush?: (listener: () => void) => () => void
      startWindowDrag?: (point: WindowDragPoint) => void
      moveWindowDrag?: (point: WindowDragPoint) => void
      endWindowDrag?: () => void
    }
  }
}

const apiBase: string = window.littlesheep?.apiBase ?? 'http://127.0.0.1:0'

export function localApiUrl(path: string): string {
  return `${apiBase}${path}`
}

export interface LocalApiError extends Error {
  status: number
}

export function localApiStatusError(status: number, message = `Local app API error: ${status}`): LocalApiError {
  const error = new Error(message) as LocalApiError
  error.status = status
  return error
}

export async function localApiResponseError(res: Response): Promise<Error> {
  const data = await res.json().catch(() => null) as { error?: string } | null
  return localApiStatusError(res.status, data?.error ?? `Local app API error: ${res.status}`)
}

export function parseSseFrame(frame: string): { name: string; data: unknown } | null {
  let name = 'message'
  const dataLines: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      name = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart())
    }
  }
  if (dataLines.length === 0) return null
  return { name, data: JSON.parse(dataLines.join('\n')) }
}
