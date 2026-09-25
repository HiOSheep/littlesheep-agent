// Client for the bounded loopback preview service that runs a workspace HTML page.
//
// The static preview never executes page scripts, so "run" asks Main for a
// tokenised loopback URL scoped to the selected workspace and opens it in the
// embedded browser. Main owns the boundary (root, real paths, token, lifetime);
// this client only carries the request.
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes'
import { localApiFetch, localApiResponseError } from './common'

export interface WorkspacePreviewServerInfo {
  root: string
  url: string
  entry: string
  startedAt: string
  requests: number
}

export async function startWorkspacePreviewServer(
  root: string,
  path: string,
): Promise<WorkspacePreviewServerInfo> {
  const response = await localApiFetch(LOCAL_APP_API_ROUTES.workspacePreviewServer, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, path }),
  })
  if (!response.ok) throw await localApiResponseError(response)
  return response.json() as Promise<WorkspacePreviewServerInfo>
}

export async function stopWorkspacePreviewServer(root: string): Promise<{ stopped: boolean }> {
  const query = new URLSearchParams({ root })
  const response = await localApiFetch(`${LOCAL_APP_API_ROUTES.workspacePreviewServer}?${query}`, {
    method: 'DELETE',
  })
  if (!response.ok) throw await localApiResponseError(response)
  return response.json() as Promise<{ stopped: boolean }>
}
