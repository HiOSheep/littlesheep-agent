// Renderer transport client for bounded workspace Git review snapshots and diffs.
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes'
import type {
  WorkspaceReviewFileDiff,
  WorkspaceReviewSnapshot,
} from '../../shared/workspace-review-contracts'
import { localApiFetch, localApiResponseError } from './common'

function reviewQuery(root: string, path?: string, revision?: string, force = false): string {
  const params = new URLSearchParams({ root })
  if (path) params.set('path', path)
  if (revision) params.set('revision', revision)
  if (force) params.set('force', '1')
  return params.toString()
}

export async function getWorkspaceReview(
  root: string,
  options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<WorkspaceReviewSnapshot> {
  const response = await localApiFetch(
    `${LOCAL_APP_API_ROUTES.workspaceReview}?${reviewQuery(root, undefined, undefined, options.force)}`,
    { signal: options.signal },
  )
  if (!response.ok) throw await localApiResponseError(response)
  return response.json() as Promise<WorkspaceReviewSnapshot>
}

export async function getWorkspaceReviewDiff(
  root: string,
  path: string,
  revision: string,
  options: { signal?: AbortSignal } = {},
): Promise<WorkspaceReviewFileDiff> {
  const response = await localApiFetch(
    `${LOCAL_APP_API_ROUTES.workspaceReviewDiff}?${reviewQuery(root, path, revision)}`,
    { signal: options.signal },
  )
  if (!response.ok) throw await localApiResponseError(response)
  return response.json() as Promise<WorkspaceReviewFileDiff>
}
