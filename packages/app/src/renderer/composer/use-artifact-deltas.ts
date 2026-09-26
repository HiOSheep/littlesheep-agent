// Per-file line counts for the chat's artifact card.
//
// The numbers come from the same Git review snapshot the review panel reads, through the shared
// bounded cache: one request per workspace root, deduplicated and reused, instead of one per message
// that happens to mention a file. When Git cannot count a file (a binary, a bounded scan, a path
// outside the repository) there is simply no number — the card shows nothing rather than a guess.
import { useEffect, useMemo, useState } from 'react'
import type { WorkspaceReviewSnapshot } from '../../shared/workspace-review-contracts'
import { workspaceReviewCache } from '../workspace/review-cache'

export interface ArtifactLineDelta {
  additions: number
  deletions: number
}

function comparablePath(path: string): string {
  return path.replace(/\//gu, '\\').toLocaleLowerCase('en-US')
}

/** The snapshot's changed files, keyed the way artifact paths arrive from the transcript. */
export function artifactDeltas(snapshot: WorkspaceReviewSnapshot | null): Map<string, ArtifactLineDelta> {
  const deltas = new Map<string, ArtifactLineDelta>()
  for (const file of snapshot?.files ?? []) {
    if (!file.countAvailable || file.binary) continue
    deltas.set(comparablePath(file.absolutePath), { additions: file.additions, deletions: file.deletions })
  }
  return deltas
}

export function useArtifactDeltas(workspaceRoot: string, version: number): Map<string, ArtifactLineDelta> {
  const [snapshot, setSnapshot] = useState<WorkspaceReviewSnapshot | null>(
    () => (workspaceRoot ? workspaceReviewCache.readSnapshot(workspaceRoot) : null),
  )

  useEffect(() => {
    if (!workspaceRoot) {
      setSnapshot(null)
      return
    }
    let alive = true
    setSnapshot(workspaceReviewCache.readSnapshot(workspaceRoot))
    void workspaceReviewCache.loadSnapshot(workspaceRoot)
      .then((loaded) => {
        if (alive) setSnapshot(loaded)
      })
      .catch(() => {
        // No repository, no numbers: the card keeps its rows and drops the counts.
        if (alive) setSnapshot(null)
      })
    return () => {
      alive = false
    }
  }, [workspaceRoot, version])

  return useMemo(() => artifactDeltas(snapshot), [snapshot])
}

export function lineDeltaFor(
  deltas: Map<string, ArtifactLineDelta>,
  path: string,
): ArtifactLineDelta | null {
  return deltas.get(comparablePath(path)) ?? null
}
