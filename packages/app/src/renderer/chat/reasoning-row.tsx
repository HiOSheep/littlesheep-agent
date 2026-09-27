// One reasoning entry of the model transcript.
//
// The chain of thought is the one row worth showing while it is still arriving, so it opens itself
// for as long as the model is thinking; from the moment the reader clicks, their choice wins. The
// text is the same Markdown either way — it streams in as it arrives.
import { useState } from 'react'
import { shortActivityText } from './task-progress-indicator'
import { Markdown } from '../Markdown'
import { ActivityGlyph } from './activity-glyph'
import { DisclosurePanel } from './disclosure-panel'

export function ReasoningRow({
  id,
  text,
  status,
}: {
  id: string
  text: string
  status: 'running' | 'done' | 'failed' | 'aborted'
}) {
  const [pinnedOpen, setPinnedOpen] = useState<boolean | null>(null)
  // While the model is still thinking the row opens itself; from the reader's
  // first click on, their choice wins.
  const open = pinnedOpen ?? status === 'running'

  return (
    <div className={`agent-transcript-reasoning ${status}`} data-transcript-entry={id}>
      <button
        type="button"
        className="agent-flow-row"
        aria-expanded={open}
        onClick={() => setPinnedOpen(!open)}
      >
        <span className="agent-flow-glyph agent-reasoning-glyph" aria-hidden="true"><ActivityGlyph kind="reasoning" /></span>
        <span className="agent-flow-title">思考</span>
        <span className="agent-flow-separator" aria-hidden="true" />
        <span className="agent-flow-summary">{shortActivityText(text, 200)}</span>
        <span className={`agent-flow-chevron${open ? ' open' : ''}`} aria-hidden="true" />
      </button>
      <DisclosurePanel open={open}>
        <div className="agent-transcript-details">
          <Markdown text={text} streaming={status === 'running'} />
        </div>
      </DisclosurePanel>
    </div>
  )
}
