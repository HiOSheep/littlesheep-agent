// The floating surface a transient confirmation appears in.
//
// Two properties are the whole point, and both are why this is not just CSS on the
// existing notice:
//
//   1. It floats. The notice used to be a block in the page flow, so showing and
//      hiding it pushed the page's content down and back up. A portal to `body` with
//      `position: fixed` removes it from layout entirely — nothing below it moves
//      when it appears or disappears.
//   2. It is announced, not merely drawn. A screen reader has to hear a confirmation
//      that disappears on its own, so the surface keeps `role="status"` and a polite
//      live region. The auto-hide is a visual convenience; the announcement is the
//      contract.
//
// Errors deliberately do NOT come through here. A failure that vanishes after three
// seconds is a failure the user can miss, so `FeedbackNotice` keeps rendering
// persistent failures in place (see `use-transient-notice.ts`).
import { createPortal } from 'react-dom'
import type { Feedback } from './feedback'
import { FeedbackNotice } from './feedback-notice'

export function TransientNoticeToast({
  notice,
  onDismiss,
}: {
  notice: Feedback | null
  /** Lets the user close it early; the timer is not the only way out. */
  onDismiss: () => void
}) {
  if (!notice) return null
  const surface = (
    <div className="transient-toast" data-tone={notice.tone}>
      <FeedbackNotice className="transient-toast-notice" feedback={notice} />
      <button
        type="button"
        className="transient-toast-dismiss"
        aria-label="关闭提示"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  )
  // The renderer may be mounted without a document in unit tests, and the surface
  // must stay testable there rather than requiring a DOM to render at all.
  return typeof document === 'undefined' ? surface : createPortal(surface, document.body)
}
