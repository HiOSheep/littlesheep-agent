// Names for the changes Git records without any text hunk (UX-28 item 3).
//
// A pure rename is a real change that a diff view otherwise shows as "no line diff";
// these helpers turn Git's extended headers into something a person reads, while keeping
// the raw value visible (a mode like `100755` means nothing on its own to most users, so
// it is labelled *and* shown).
import type { WorkspaceReviewDiffMetadata } from '../api'

const LABELS: Record<string, string> = {
  'old mode': '旧权限',
  'new mode': '新权限',
  'deleted file mode': '删除前权限',
  'new file mode': '新增权限',
  'rename from': '重命名自',
  'rename to': '重命名为',
  'copy from': '复制自',
  'copy to': '复制为',
  'similarity index': '相似度',
  'dissimilarity index': '差异度',
}

export function diffMetadataLabel(key: string): string {
  return LABELS[key] ?? key
}

/** The value, with the mode number explained the way Git's own docs describe it. */
export function diffMetadataValue(entry: WorkspaceReviewDiffMetadata): string {
  const mode = /^(?:old mode|new mode|deleted file mode|new file mode)$/u.test(entry.key)
    ? describeFileMode(entry.value)
    : null
  return mode ? `${entry.value}（${mode}）` : entry.value
}

/** `100644` is a regular file, `100755` an executable one; anything else stays raw. */
export function describeFileMode(mode: string): string | null {
  if (mode === '100644') return '普通文件'
  if (mode === '100755') return '可执行文件'
  if (mode === '120000') return '符号链接'
  if (mode === '160000') return '子模块'
  return null
}
