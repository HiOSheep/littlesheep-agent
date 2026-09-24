// The workspace clients must build real Local App API paths.
//
// A missing `${` in one of these template literals turned every directory read
// into `http://127.0.0.1:<port>LOCAL_APP_API_ROUTES.workspaceList)}?...`, which
// `fetch` rejects as an unparseable URL. The renderer then showed the generic
// "文件夹暂时无法读取" notice and never asked the server again, so the whole right
// side stayed unusable while the same route answered 200 when called directly.
// These assertions are about the request the client actually issues.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes'
import { localApiFetch } from './common'

vi.mock('./common', () => ({
  localApiFetch: vi.fn(),
  localApiStatusError: (status: number) => new Error(`Local app API error: ${status}`),
}))

const mockedFetch = vi.mocked(localApiFetch)

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response
}

function requestedPath(index = -1): string {
  const call = mockedFetch.mock.calls.at(index)
  return String(call?.[0] ?? '')
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedFetch.mockResolvedValue(jsonResponse({ entries: [], root: 'C:\\ws', path: 'C:\\ws' }))
})

describe('workspace client request paths', () => {
  it('asks for the directory listing on the documented route', async () => {
    const { listWorkspaceDirectory } = await import('./workspace-files')
    await listWorkspaceDirectory('C:\\ws', 'C:\\ws')

    const path = requestedPath()
    expect(path.startsWith(LOCAL_APP_API_ROUTES.workspaceList)).toBe(true)
    expect(path).toContain(`?root=${encodeURIComponent('C:\\ws')}`)
    expect(path).not.toContain('LOCAL_APP_API_ROUTES')
    expect(path).not.toContain(')}')
  })

  it('asks for a file preview on the documented route', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ kind: 'text', content: 'body', path: 'C:\\ws\\a.md', name: 'a.md' }))
    const { previewWorkspaceFile } = await import('./workspace-files')
    await previewWorkspaceFile('C:\\ws', 'C:\\ws\\a.md')

    const path = requestedPath()
    expect(path.startsWith(LOCAL_APP_API_ROUTES.workspacePreview)).toBe(true)
    expect(path).not.toContain('LOCAL_APP_API_ROUTES')
  })

  it('keeps the layout and artifact routes well formed', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ snapshot: { sessions: {} } }))
    const files = await import('./workspace-files')
    await files.readWorkspaceLayoutSnapshot('session-1')
    expect(requestedPath().startsWith(LOCAL_APP_API_ROUTES.workspaceLayout)).toBe(true)
    expect(requestedPath()).not.toContain('LOCAL_APP_API_ROUTES')

    mockedFetch.mockResolvedValue(jsonResponse({ artifacts: [] }))
    await files.listWorkspaceArtifacts('C:\\ws', 'session-1', 20)
    expect(requestedPath().startsWith(LOCAL_APP_API_ROUTES.workspaceArtifacts)).toBe(true)
    expect(requestedPath()).not.toContain('LOCAL_APP_API_ROUTES')
  })

  it('keeps the terminal activity route well formed', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ activity: [], sessions: [] }))
    const terminal = await import('./terminal')
    await terminal.listWorkspaceTerminalActivity('C:\\ws')

    const path = requestedPath()
    expect(path.startsWith(LOCAL_APP_API_ROUTES.terminalActivity)).toBe(true)
    expect(path).not.toContain('LOCAL_APP_API_ROUTES')
  })
})
