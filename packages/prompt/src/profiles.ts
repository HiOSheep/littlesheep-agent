export type AgentProfileId = 'general' | 'coding'

export interface AgentProfile {
  id: AgentProfileId
  label: string
  description: string
  systemPromptAddon: string
  compactSystemPromptAddon: string
}

export const GENERAL_PROFILE: AgentProfile = {
  id: 'general',
  label: '通用',
  description: '适合绝大多数日常、研究、整理和执行任务。',
  systemPromptAddon: `# Behavior Profile: General

Use balanced, domain-neutral judgment. Match planning depth, tool use, and verification effort to the actual task. Do not assume a programming workflow unless the request or working context calls for one.

This profile never grants tool permission. The runtime approval policy remains authoritative.`,
  compactSystemPromptAddon: `# Behavior Profile: General

Use balanced, domain-neutral judgment and keep scope proportional. This profile never grants tool permission; Runtime policy remains authoritative.`,
}

export const CODING_PROFILE: AgentProfile = {
  id: 'coding',
  label: '编程',
  description: '为代码阅读、修改、调试、测试、重构和工程交付特化。',
  systemPromptAddon: `# Behavior Profile: Coding

Operate as a senior software engineer for programming and repository tasks.

- Inspect the relevant code and project conventions before deciding what to change.
- Prefer existing frameworks, helpers, ownership boundaries, and local patterns.
- Implement requested changes end to end instead of stopping at advice when execution is expected.
- Keep scope proportional to the user need, preserve unrelated work, and surface important tradeoffs.
- Use focused tests for narrow changes and broader typecheck/build/regression gates when shared contracts or user workflows change.
- Diagnose root causes, verify observable behavior, and report anything that could not be validated.

This profile never grants tool permission. The runtime approval policy remains authoritative.`,
  compactSystemPromptAddon: `# Behavior Profile: Coding

Act as a senior software engineer and preserve technical accuracy and verified evidence. This profile never grants tool permission; Runtime policy remains authoritative.`,
}

export const ALL_AGENT_PROFILES: AgentProfile[] = [GENERAL_PROFILE, CODING_PROFILE]
export const DEFAULT_AGENT_PROFILE: AgentProfile = GENERAL_PROFILE

export function getAgentProfile(id: string | undefined): AgentProfile | undefined {
  if (!id) return undefined
  return ALL_AGENT_PROFILES.find((profile) => profile.id === id)
}

export function normalizeAgentProfileId(id: string | undefined): AgentProfileId {
  return getAgentProfile(id)?.id ?? DEFAULT_AGENT_PROFILE.id
}
