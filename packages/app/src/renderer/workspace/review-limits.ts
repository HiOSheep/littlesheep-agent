// Where the review's limits are stated when the list is not on screen (UX-28 item 5).
//
// The changed-file list lives in the review navigator, and collapsing that navigator
// hides the whole list — including the line that says the list is capped. The limits are
// therefore repeated in the review body, but only while the navigator is collapsed, so
// the two surfaces never say the same thing at once.
//
// Pure: the caller passes the facts, this decides whether a sentence is needed.

export interface ReviewLimitInput {
  /** The navigator that normally states the cap is collapsed. */
  navigatorCollapsed: boolean
  filesTruncated: boolean
  /** Files actually listed. */
  fileCount: number
  /** Files that exist in the change set. */
  totalFileCount: number
  /** Layers whose content was cut by the per-layer limit (optional: the view adds it). */
  truncatedLayers?: number
}

export interface ReviewLimitNotice {
  text: string
  /** Which limits the sentence covers, for styling and tests. */
  kinds: Array<'files' | 'layers'>
}

/** The sentence the body has to carry, or null when the navigator already says it. */
export function reviewLimitNotice(input: ReviewLimitInput): ReviewLimitNotice | null {
  if (!input.navigatorCollapsed) return null
  const kinds: ReviewLimitNotice['kinds'] = []
  const parts: string[] = []
  if (input.filesTruncated) {
    kinds.push('files')
    parts.push(`显示前 ${input.fileCount} 个，共 ${input.totalFileCount} 个文件`)
  }
  const truncatedLayers = input.truncatedLayers ?? 0
  if (truncatedLayers > 0) {
    kinds.push('layers')
    parts.push(`${truncatedLayers} 个差异层已达上限`)
  }
  if (parts.length === 0) return null
  return { text: `${parts.join('；')}。`, kinds }
}
