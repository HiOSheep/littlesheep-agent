// Leaf label helper shared by the artifact card and the file strip. Keeping it
// out of message-files.tsx breaks the card ↔ strip import cycle.
import type { WorkspaceArtifactRef } from '../workspace/types'

export function fileActionLabel(action: WorkspaceArtifactRef['action']): string {
  if (action === 'attached') return '附件'
  return action === 'created' ? '写入调用成功' : '修改调用成功'
}
