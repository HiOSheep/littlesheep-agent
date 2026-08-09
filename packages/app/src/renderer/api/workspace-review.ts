// Renderer transport client for bounded workspace Git review snapshots and diffs.
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes'
import type {
  WorkspaceReviewFileDiff,
  WorkspaceReviewSnapshot,
} from '../../shared/workspace-review-contracts'
import { localApiResponseError, localApiUrl } from './common'

function reviewQuery(root: string, path?: string): string {
  const params = new URLSearchParams({ root })
  if (path) params.set('path', path)
  return params.toString()
}

export async function getWorkspaceReview(
  root: string,
  options: { signal?: AbortSignal } = {},
): Promise<WorkspaceReviewSnapshot> {
  const response = await fetch(
    `${localApiUrl(LOCAL_APP_API_ROUTES.workspaceReview)}?${reviewQuery(root)}`,
    { signal: options.signal },
  )
  if (!response.ok) throw await localApiResponseError(response)
  return response.json() as Promise<WorkspaceReviewSnapshot>
}

export async function getWorkspaceReviewDiff(
  root: string,
  path: string,
  options: { signal?: AbortSignal } = {},
): Promise<WorkspaceReviewFileDiff> {
  const response = await fetch(
    `${localApiUrl(LOCAL_APP_API_ROUTES.workspaceReviewDiff)}?${reviewQuery(root, path)}`,
    { signal: options.signal },
  )
  if (!response.ok) throw await localApiResponseError(response)
  return response.json() as Promise<WorkspaceReviewFileDiff>
}
