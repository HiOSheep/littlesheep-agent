// @littlesheep/app — main/bootstrap-templates.ts
// Initial content for the runtime copies of the user-data memory files.
// Data only: the bootstrap sequence that materializes these lives in index.ts.

export const BOOTSTRAP_TEMPLATES: Record<string, string> = {
  'AGENTS.md': [
    '# AGENTS.md',
    '',
    'Project-level operating instructions for LittleSheep.',
    'Add durable rules here when you want every run to follow them.',
    '',
  ].join('\n'),
  'USER.md': [
    '# USER.md',
    '',
    'Durable user preferences and profile notes live here.',
    'Keep this concise and update it when preferences change.',
    '',
  ].join('\n'),
  'PHILOSOPHY.md': [
    '# PHILOSOPHY.md',
    '',
    '这里保存经用户确认的长期价值判断、设计取舍和共同工作理念。',
    'LS 只在任务相关时沿资源索引按需读取，不会把全文常驻到每轮上下文。',
    '',
  ].join('\n'),
  'TOOLS.md': [
    '# TOOLS.md',
    '',
    'Tool usage conventions and local command policies live here.',
    'Record lessons that prevent repeated tool mistakes.',
    '',
  ].join('\n'),
  'MEMORY.md': [
    '# MEMORY.md',
    '',
    'Curated long-term memory for LittleSheep.',
    'Daily detailed memory lives in the memory/ directory.',
    '',
  ].join('\n'),
  'SOUL.md': [
    '# SOUL.md',
    '',
    'Voice, temperament, and identity notes for LittleSheep.',
    'Keep the stable personality here; keep task rules in AGENTS.md.',
    '',
  ].join('\n'),
}
