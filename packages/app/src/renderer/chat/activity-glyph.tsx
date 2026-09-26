// The glyphs that mark what a transcript row is: a step, the model's thinking, a system prompt, and
// the context projections. They live here rather than inside the turn component so the rows that use
// them can be their own modules.
export function ActivityGlyph({
  kind,
}: {
  kind: 'system' | 'reasoning' | 'step' | 'context_injection' | 'cross_session_recall' | 'context_compaction'
}) {
  const common = { className: 'agent-activity-svg', viewBox: '0 0 16 16' }
  if (kind === 'system') return <svg {...common}><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M5 6h6M5 9h4M5 12h2" /></svg>
  if (kind === 'reasoning') return <svg {...common}><path d="M5.2 11.5h5.6M6 13.5h4M4.6 9.5C3.5 8.6 3 7.4 3 6.2a5 5 0 0 1 10 0c0 1.3-.5 2.4-1.6 3.3-.6.5-.7 1-.7 2H5.3c0-1-.1-1.5-.7-2Z" /></svg>
  if (kind === 'cross_session_recall') return <svg {...common}><path d="M3 5.5A5.5 5.5 0 1 1 2.8 10" /><path d="M3 2.5v3H6M8 5v3l2 1.2" /></svg>
  if (kind === 'context_compaction') return <svg {...common}><path d="M2.5 5h4V1M13.5 5h-4V1M2.5 11h4v4M13.5 11h-4v4" /><path d="m6.5 9.5 3-3" /></svg>
  if (kind === 'context_injection') return <svg {...common}><path d="M8 2v9M4.5 7.5 8 11l3.5-3.5M3 14h10" /></svg>
  return <svg {...common}><circle cx="8" cy="8" r="5.5" /><path d="m5.5 8 1.7 1.7 3.5-3.7" /></svg>
}
