// Why the send control is disabled, stated in the control row.
//
// The Runtime's startup window already has its own surfaces: the stage sentence
// beside the send control while starting (`runtime-readiness/composer-readiness-hint.tsx`)
// and the window-wide strip when it failed. This one covers only the composer's
// own unmet prerequisite, so the two cannot both claim the row: with no usable
// model the send entry refuses (see `send-readiness.ts`) and a disabled button
// alone would never say why. The sentence is the Runtime's own fact, not copy
// invented here, and the disabled control carries the same sentence as its
// accessible name.

export function ComposerSendBlockNotice({
  executionReason,
  modelReason,
}: {
  /** The Runtime readiness reason; non-null while execution is unavailable. */
  executionReason: string | null
  /** Why the composer's model prerequisite is unmet, when it is. */
  modelReason: string | null
}) {
  if (executionReason || !modelReason) return null
  return (
    <span className="composer-readiness-hint composer-send-block" role="status" title={modelReason}>
      {modelReason}
    </span>
  )
}
