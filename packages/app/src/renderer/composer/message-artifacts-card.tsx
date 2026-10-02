// The chat's "产出成果" card.
//
// One card per turn instead of a grid of chips: a header that names the turn's产出 and totals its
// line changes, the files themselves as rows with their own counts on the right, and a footer that
// opens the rest when there are more than a few. The counts stay neutral until the pointer is on
// them — a wall of green and red reads as noise when a turn touched ten files.
//
// Two targets per row, both of them places the reader can already go:
//   the row itself  → the file's preview in the extended workspace
//   the counts      → that file's review (its diff), so "+12 -3" is a way in, not decoration
import { useState } from 'react'
import type { WorkspaceArtifactRef } from '../workspace/types'
import { FileGlyphIcon } from '../ui/icons'
import { compactPath } from '../workspace/path-utils'
import { fileActionLabel } from './message-files'
import { lineDeltaFor, type ArtifactLineDelta } from './use-artifact-deltas'

/** How many rows the card shows before its footer has to be used. */
export const ARTIFACT_CARD_VISIBLE_ROWS = 4

export function MessageArtifactsCard({
  files,
  deltas,
  onOpenFile,
  onOpenReview,
}: {
  files: WorkspaceArtifactRef[]
  deltas: Map<string, ArtifactLineDelta>
  onOpenFile: (path: string) => void
  onOpenReview: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? files : files.slice(0, ARTIFACT_CARD_VISIBLE_ROWS)
  const totals = totalDelta(files, deltas)
  const hiddenCount = files.length - shown.length

  return (
    <section className="message-artifacts-card" aria-label="产出成果">
      <header className="message-artifacts-head">
        <span className="message-artifacts-head-icon" aria-hidden="true">
          <FileGlyphIcon name={files[0]?.name} />
        </span>
        <strong>已产出 {files.length} 个文件</strong>
        {totals && (
          <span className="message-artifacts-total" aria-label={totalDeltaLabel(totals)}>
            <span className="line-delta-add">+{totals.additions}</span>
            {/* Both numbers are always written, `-0` included: the count is read as a pair, and a
                lone `+661` leaves the reader wondering whether the turn removed nothing or whether
                this card simply does not say. Where the `0` stands in for lines nobody counted, the
                label the reader hears says so instead of the number going missing. */}
            <span className="line-delta-remove">-{totals.deletions ?? 0}</span>
          </span>
        )}
      </header>
      <div className="message-artifacts-rows">
        {shown.map((file) => (
          <ArtifactRow
            key={`${file.action}:${file.path}`}
            file={file}
            delta={lineDeltaFor(deltas, file.path)}
            onOpen={() => onOpenFile(file.path)}
            onOpenReview={() => onOpenReview(file.path)}
          />
        ))}
      </div>
      {files.length > ARTIFACT_CARD_VISIBLE_ROWS && (
        <button
          className="message-artifacts-more"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起' : `全部 ${files.length} 个文件`}
          <span className={`message-artifacts-more-arrow ${expanded ? 'open' : ''}`} aria-hidden="true" />
        </button>
      )}
      {!expanded && hiddenCount > 0 && <span className="visually-hidden">还有 {hiddenCount} 个文件未显示</span>}
    </section>
  )
}

function ArtifactRow({
  file,
  delta,
  onOpen,
  onOpenReview,
}: {
  file: WorkspaceArtifactRef
  delta: ArtifactLineDelta | null
  onOpen: () => void
  onOpenReview: () => void
}) {
  return (
    <div className={`message-artifacts-row ${file.action}`}>
      <button
        className="message-artifacts-row-open"
        type="button"
        title={`${fileActionLabel(file.action)} · ${file.path}`}
        onClick={onOpen}
      >
        <span className="message-artifacts-row-path">{compactPath(file.path)}</span>
        <span className="message-artifacts-row-action">{fileActionLabel(file.action)}</span>
      </button>
      {delta && (
        <button
          className="message-artifacts-row-delta"
          type="button"
          aria-label={fileDeltaLabel(file.name, delta)}
          title="查看这个文件的审阅"
          onClick={onOpenReview}
        >
          <span className="line-delta-add">+{delta.additions}</span>
          <span className="line-delta-remove">-{delta.deletions ?? 0}</span>
        </button>
      )}
    </div>
  )
}

/** The count a reader hears: the same pair as the screen, plus where a `0` came from. */
function fileDeltaLabel(name: string, delta: ArtifactLineDelta): string {
  const spoken = `查看 ${name} 的审阅：新增 ${delta.additions} 行，删除 ${delta.deletions ?? 0} 行`
  return delta.deletions === null ? `${spoken}（写入前的行数未知）` : spoken
}

function totalDeltaLabel(totals: ArtifactLineDelta): string {
  const spoken = `共新增 ${totals.additions} 行，删除 ${totals.deletions ?? 0} 行`
  return totals.deletions === null ? `${spoken}（部分文件写入前的行数未知）` : spoken
}

function totalDelta(
  files: WorkspaceArtifactRef[],
  deltas: Map<string, ArtifactLineDelta>,
): ArtifactLineDelta | null {
  let additions = 0
  let deletions = 0
  let counted = 0
  // A file nobody counted contributes a displayed `0`, so the total has to say that its own `0` is
  // partly an assumption: the sum stays a sum, and the label carries the caveat.
  let deletionsKnown = true
  for (const file of files) {
    const delta = lineDeltaFor(deltas, file.path)
    if (!delta) continue
    additions += delta.additions
    if (delta.deletions === null) deletionsKnown = false
    else deletions += delta.deletions
    counted += 1
  }
  return counted > 0 ? { additions, deletions: deletionsKnown ? deletions : null } : null
}
