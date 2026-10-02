// Per-file line counts for the chat's artifact card.
//
// Two sources, in one order of authority. The Git review snapshot is the exact state of the working
// tree, so it wins wherever it has the file (and it is the only source that knows a created file
// deleted nothing). The turn's own file-writing calls fill in everything Git cannot answer — a
// workspace that is not a repository still produced these files, and the card can say how much each
// of them changed without asking Git at all. Both are keyed by the same file identity, so a row and
// its counts can never disagree about which file they describe.
//
// The numbers stay bounded and honest: the Git snapshot comes from the shared bounded cache (one
// request per workspace root, deduplicated and reused), and a tool call that cannot carry its old
// lines reports them as unknown rather than as zero, exactly like the transcript rows do.
import { useEffect, useMemo, useState } from 'react'
import type { WorkspaceReviewSnapshot } from '../../shared/workspace-review-contracts'
import { artifactIdentity, toolFilePath } from '../chat/activity-model'
import { toolLineDelta } from '../chat/tool-line-delta'
import { workspaceReviewCache } from '../workspace/review-cache'

export interface ArtifactLineDelta {
  additions: number
  /** Null when the source cannot say: an overwritten file's old lines are not part of the call. */
  deletions: number | null
}

/** One of the turn's own calls, as the transcript and the card both see it. */
export interface ArtifactToolCall {
  name: string
  input?: unknown
  /** The runtime's own count for the call, when the stream carried one. */
  lineProgress?: { additions: number; deletions: number | null }
}

/** The snapshot's changed files, keyed the way artifact paths arrive from the transcript. */
export function artifactDeltas(snapshot: WorkspaceReviewSnapshot | null): Map<string, ArtifactLineDelta> {
  const deltas = new Map<string, ArtifactLineDelta>()
  for (const file of snapshot?.files ?? []) {
    if (!file.countAvailable || file.binary) continue
    deltas.set(artifactIdentity(file.absolutePath), { additions: file.additions, deletions: file.deletions })
  }
  return deltas
}

/** What this turn's own calls wrote, for the files Git cannot count. */
export function toolCallDeltas(tools?: readonly ArtifactToolCall[]): Map<string, ArtifactLineDelta> {
  const deltas = new Map<string, ArtifactLineDelta>()
  for (const tool of tools ?? []) {
    const path = toolFilePath(tool.input)
    if (!path) continue
    const delta = tool.lineProgress ?? toolLineDelta(tool.name, tool.input)
    if (!delta) continue
    deltas.set(artifactIdentity(path), { additions: delta.additions, deletions: delta.deletions })
  }
  return deltas
}

/** Snapshot first: it answers with the working tree, which is what the review panel shows too. */
export function mergeArtifactDeltas(
  fromTools: Map<string, ArtifactLineDelta>,
  fromSnapshot: Map<string, ArtifactLineDelta>,
): Map<string, ArtifactLineDelta> {
  if (fromTools.size === 0) return fromSnapshot
  if (fromSnapshot.size === 0) return fromTools
  return new Map([...fromTools, ...fromSnapshot])
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
        // No repository, no numbers from this source: the turn's own calls still answer.
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
  return deltas.get(artifactIdentity(path)) ?? null
}
