// Presents Git addition and deletion totals consistently across review surfaces.

export function ReviewLineCounts({
  additions,
  deletions,
  available = true,
  compact = false,
}: {
  additions: number
  deletions: number
  available?: boolean
  compact?: boolean
}) {
  if (compact && available && additions === 0 && deletions === 0) return null
  return (
    <span
      className={`workspace-review-line-counts ${compact ? 'compact' : ''}`}
      title={available ? undefined : '行数超过审阅扫描预算'}
    >
      <span className="additions">+{available ? additions : '?'}</span>
      <span className="deletions">-{available ? deletions : '?'}</span>
    </span>
  )
}
