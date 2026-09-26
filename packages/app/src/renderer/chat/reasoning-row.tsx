// One reasoning entry of the model transcript.
//
// The chain of thought is the one row worth showing while it is still arriving, so it opens itself
// for as long as the model is thinking; from the moment the reader clicks, their choice wins. The
// text is the same Markdown either way — it streams in as it arrives.
import { useState } from 'react'
import { shortActivityText } from './task-progress-indicator'
import { Markdown } from '../Markdown'
import { ActivityGlyph } from './activity-glyph'

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

  return (
    <details
      className={`agent-transcript-reasoning ${status}`}
      data-transcript-entry={id}
      open={pinnedOpen ?? status === 'running'}
      onToggle={(event) => {
        const isOpen = (event.currentTarget as HTMLDetailsElement).open
        setPinnedOpen((current) => (current === isOpen ? current : isOpen))
      }}
    >
      <summary className="agent-flow-row">
        <span className="agent-flow-glyph agent-reasoning-glyph" aria-hidden="true"><ActivityGlyph kind="reasoning" /></span>
        <span className="agent-flow-title">思考</span>
        <span className="agent-flow-separator" aria-hidden="true" />
        <span className="agent-flow-summary">{shortActivityText(text, 200)}</span>
        <span className="agent-flow-chevron" aria-hidden="true" />
      </summary>
      <div className="agent-transcript-details">
        <Markdown text={text} />
      </div>
    </details>
  )
}
