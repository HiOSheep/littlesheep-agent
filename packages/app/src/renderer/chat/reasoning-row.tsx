// One reasoning entry of the model transcript.
//
// Reasoning stays compact while streaming; the reader explicitly opens its complete text.
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
  const [open, setOpen] = useState(false)

  return (
    <div className={`agent-transcript-reasoning ${status}`} data-transcript-entry={id}>
      <button
        type="button"
        className="agent-flow-row"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="agent-flow-glyph agent-reasoning-glyph" aria-hidden="true"><ActivityGlyph kind="reasoning" /></span>
        <span className={`agent-flow-title${status === 'running' ? ' is-running' : ''}`}>思考</span>
        <span className="agent-flow-separator" aria-hidden="true" />
        <span className="agent-flow-summary">{reasoningPreview(text, status === 'running')}</span>
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

/** Advance a live preview as paragraphs complete instead of repeating the oldest thinking. */
export function reasoningPreview(text: string, running: boolean): string {
  const paragraphs = text.split(/\r?\n\s*\r?\n/u)
  const completed = running && paragraphs.length > 1 ? paragraphs.slice(0, -1) : paragraphs
  const paragraph = running ? completed[completed.length - 1] : completed[0]
  return shortActivityText(((paragraph ?? '').split(/\r?\n/u)[0] ?? '').replaceAll('**', ''), 200)
}
