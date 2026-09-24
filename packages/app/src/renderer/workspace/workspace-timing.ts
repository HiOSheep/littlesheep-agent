// The two "right side is really usable" marks (taskbook CS-08).
//
// The complaint behind CS-08 is that entering the workspace panel shows a shell
// while the real directory and file content are still missing, so the metrics
// have to be about content the user can read:
//
//   renderer-workspace-entries  - the first directory row is on screen
//   renderer-workspace-preview  - the first file body is on screen
//
// Both are reported once per renderer, on the same timeline as the first frame,
// and only when Main enabled bootstrap timing. A skeleton or a loading
// placeholder must never publish either of them.

import { reportRendererStage } from '../runtime-readiness/renderer-timing'

let entriesReported = false
let previewReported = false

/** The navigator has visible rows for the current workspace root. */
export function reportWorkspaceEntriesVisible(): void {
  if (entriesReported) return
  entriesReported = true
  reportRendererStage('renderer-workspace-entries')
}

/** A file body is painted in the preview pane (not a placeholder, not an error). */
export function reportWorkspacePreviewVisible(): void {
  if (previewReported) return
  previewReported = true
  reportRendererStage('renderer-workspace-preview')
}

/** Test seam: the marks are once-per-renderer, so tests need to reset them. */
export function resetWorkspaceTimingForTests(): void {
  entriesReported = false
  previewReported = false
}
