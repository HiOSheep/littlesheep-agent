import type { MemoryTreeOverview } from './api'

type MemoryResourceKind = MemoryTreeOverview['resources'][number]['kind']

const RESOURCE_KIND_LABELS: Record<MemoryResourceKind, string> = {
  'agent-instructions': '操作规则',
  persona: '人格配置',
  'user-profile': '用户资料',
  philosophy: '长期理念',
  'tool-guidance': '工具约定',
  'legacy-memory': '兼容记忆',
  skill: '技能',
  'project-guideline': '项目规范',
  'ui-guideline': '界面规范',
  taskbook: '任务书',
  knowledge: '知识资料',
  'summary-memory': '会话摘要',
  'attachment-manifest': '附件清单',
  attachment: '任务附件',
  'runtime-event-ledger': '运行时事件账本',
  'workspace-index': '工作区资源索引',
  'project-memory-projection': '项目记忆私有投影',
}

export function resourceKindLabel(kind: MemoryResourceKind): string {
  return RESOURCE_KIND_LABELS[kind]
}
