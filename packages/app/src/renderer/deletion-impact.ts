// Impact facts for irreversible deletions.
//
// The lines here restate what the Local App API actually does, so the
// confirmation can name the object, the scope and what stays in place:
//  - removing an archived project record also removes its archived
//    conversations and their stored session data, and never touches the
//    project folder on disk (`local-app-api/session-routes.ts`);
//  - removing a provider drops the configuration entry; the stored key stays in
//    the OS keychain (`local-app-api/provider-routes.ts`).
import type { RuntimeProvider } from '../shared/runtime-api-contracts'
import { splitModelRef } from './composer/runtime-picker'

export interface DeletionImpact {
  /** Object type shown in the confirmation heading. */
  objectType: string
  /** Exact name of the object being deleted. */
  name: string
  /** What the request removes. */
  removes: string[]
  /** What the request leaves untouched. */
  preserved: string[]
  /** Warning when something still depends on the object. */
  inUse: string | null
}

export function archivedProjectDeletionImpact(
  project: { name?: string; path: string },
  archivedSessionCount: number,
): DeletionImpact {
  return {
    objectType: '归档项目记录',
    name: project.name?.trim() || lastPathSegment(project.path),
    removes: archivedSessionCount > 0
      ? [
        `删除这条归档项目记录，以及它下面 ${archivedSessionCount} 个归档对话`,
        `同时删除这 ${archivedSessionCount} 个对话保存在本地的消息记录，删除后无法恢复`,
      ]
      : [
        '删除这条归档项目记录，删除后无法恢复',
        '当前没有随它一起归档的对话',
      ],
    preserved: ['不会删除磁盘上的项目文件夹，也不会删除文件夹里的文件和代码'],
    inUse: null,
  }
}

export function archivedSessionDeletionImpact(
  session: { title: string },
): DeletionImpact {
  return {
    objectType: '归档对话',
    name: session.title,
    removes: [
      '删除这条归档记录，以及它保存在本地的消息记录和会话摘要',
      '删除后无法恢复',
    ],
    preserved: ['不会删除工作区里的文件'],
    inUse: null,
  }
}

export function providerDeletionImpact(
  provider: RuntimeProvider,
  selectedModelRef: string,
): DeletionImpact {
  const selectedModel = selectedModelForProvider(provider, selectedModelRef)
  return {
    objectType: '供应商配置',
    name: provider.name || provider.id,
    removes: provider.models.length > 0
      ? [
        `从配置中移除供应商「${provider.name || provider.id}」（${provider.id}）`,
        `它的 ${provider.models.length} 个模型条目会一起消失，用这些模型的对话需要重新选择模型`,
      ]
      : [
        `从配置中移除供应商「${provider.name || provider.id}」（${provider.id}）`,
      ],
    preserved: [
      '已保存的 API 密钥仍留在系统密钥库中，这次删除不会清除它',
      '不会删除任何对话记录',
    ],
    inUse: selectedModel
      ? `当前选择的模型「${selectedModel}」来自这个供应商；删除后需要到模型选择器里重新指定模型。`
      : null,
  }
}

/** Model id of the current selection when this provider owns it. */
export function selectedModelForProvider(
  provider: RuntimeProvider,
  selectedModelRef: string,
): string | null {
  const ref = selectedModelRef.trim()
  if (!ref) return null
  const { providerId, model } = splitModelRef(ref)
  if (providerId === provider.id && provider.models.some((entry) => entry.id === model)) return model
  if (!providerId && provider.models.some((entry) => entry.id === model)) return model
  return null
}

function lastPathSegment(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean)
  return parts.at(-1) ?? path
}
