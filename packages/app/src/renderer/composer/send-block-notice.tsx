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
//
// It states a different fact than the startup stage sentence, so it keeps its own
// class (`composer-send-block`) instead of borrowing `.composer-readiness-hint`:
// one class in the DOM means one thing. It only shares that sentence's appearance,
// through the selector list in `styles/11-runtime-readiness.css`.

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
    <span className="composer-send-block" role="status" title={modelReason}>
      {modelReason}
    </span>
  )
}
