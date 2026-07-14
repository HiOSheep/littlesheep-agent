// Renderer-only runtime option metadata shared by settings and composer controls.
import { ALL_AGENT_PROFILES } from '@littlesheep/prompt'
import {
type RuntimeReasoning
} from '../../shared/model-capabilities'
import { ALL_PERMISSION_MODES } from '../../shared/permission-modes'
import {
type AgentProfileId,
type PermissionModeId
} from '../api'


export type ModeRisk = 'low' | 'medium' | 'high' | 'critical'


export const MODE_OPTIONS: Array<{
  id: PermissionModeId
  label: string
  desc: string
  risk: ModeRisk
  riskLabel: string
}> = ALL_PERMISSION_MODES.map((mode) => ({
  id: mode.id,
  label: mode.label,
  desc: mode.description,
  risk: mode.risk,
  riskLabel: mode.riskLabel,
}))


export const PROFILE_OPTIONS: Array<{
  id: AgentProfileId
  label: string
  desc: string
}> = ALL_AGENT_PROFILES.map((profile) => ({
  id: profile.id,
  label: profile.label,
  desc: profile.description,
}))


export const REASONING_OPTIONS: Array<{ id: RuntimeReasoning; label: string; desc: string }> = [
  { id: 'auto', label: '自动', desc: '由任务复杂度决定' },
  { id: 'low', label: '快速', desc: '优先速度，适合简单问答' },
  { id: 'medium', label: '标准', desc: '速度和稳妥性平衡' },
  { id: 'high', label: '深度', desc: '更充分地规划和验证' },
  { id: 'ultra', label: '超高', desc: '复杂任务使用最谨慎策略' },
]
