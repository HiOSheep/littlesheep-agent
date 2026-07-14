// Shared renderer API transport helpers. Domain clients only depend on these
// helpers and the canonical route/contract modules.

declare global {
  interface Window {
    littlesheep: {
      apiBase: string
      getPathForFile?: (file: unknown) => string
    }
  }
}

const apiBase: string = window.littlesheep?.apiBase ?? 'http://127.0.0.1:0'

export function localApiUrl(path: string): string {
  return `${apiBase}${path}`
}

export function localApiStatusError(status: number): Error {
  return new Error(`Local app API error: ${status}`)
}

export async function localApiResponseError(res: Response): Promise<Error> {
  const data = await res.json().catch(() => null) as { error?: string } | null
  return new Error(data?.error ?? `Local app API error: ${res.status}`)
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
