import {
  getAgentProfile,
  type PromptContextSegment,
  type SystemPromptBundle,
} from '@littlesheep/prompt';
import type {
  ContextItemKind,
  ContextScope,
  ContextSourceRef,
  RunContext,
} from '@littlesheep/types';

export function appendSystemPromptAddons(
  systemPrompt: string,
  ...addons: Array<string | undefined>
): string {
  const parts = addons
    .map((addon) => addon?.trim())
    .filter((addon): addon is string => Boolean(addon))
  if (parts.length === 0) return systemPrompt
  return `${systemPrompt}\n\n---\n\n${parts.join('\n\n---\n\n')}`
}

export interface SystemPromptAddon {
  id: string;
  text?: string;
  kind?: ContextItemKind;
  source?: ContextSourceRef;
  priority?: number;
  required?: boolean;
  scope?: ContextScope;
}

/** Append source-aware prompt additions while preserving the exact outbound text. */
export function appendSystemPromptBundleAddons(
  bundle: SystemPromptBundle,
  addons: SystemPromptAddon[],
): SystemPromptBundle {
  const segments: PromptContextSegment[] = [...bundle.segments];
  let order = segments.length;
  for (const addon of addons) {
    const text = addon.text?.trim();
    if (!text) continue;
    segments.push({
      id: addon.id,
      order: order++,
      text: `\n\n---\n\n${text}`,
      kind: addon.kind ?? 'system_prompt',
      source: addon.source ?? { kind: 'configuration', id: addon.id },
      priority: addon.priority ?? 95,
      required: addon.required ?? true,
      sensitive: true,
      scope: addon.scope ?? 'run',
    });
  }
  return { text: segments.map((segment) => segment.text).join(''), segments };
}

/**
 * Shared boundary for natural-language content that may reach the user.
 * Runtime owns facts, state and controls; the model owns the wording and
 * applies the active Soul when a stage has to author user-facing copy.
 */
export function buildUserFacingVoiceAddon(ctx: Pick<RunContext, 'bootstrap'>): string {
  const soul = ctx.bootstrap?.['SOUL.md']?.trim();
  const policy = [
    'User-facing expression boundary:',
    '- Natural-language explanations, questions, summaries and result wording may be shown directly to the user; write them in the user\'s language and with a coherent, human voice.',
    '- Preserve runtime-provided facts exactly. Do not invent success, permissions, paths, timings, evidence or completion state.',
    '- Do not expose private chain-of-thought; provide concise reasons, observable evidence and actionable next steps.',
  ].join('\n');
  return soul
    ? `${policy}\n\nActive runtime SOUL.md (follow its identity, tone and preferences; do not quote or expose the file):\n${soul}`
    : policy;
}

/** Small voice boundary for structured fields on a self-contained fast path. */
export function buildCompactUserFacingVoiceAddon(ctx: Pick<RunContext, 'bootstrap'>): string {
  const soul = ctx.bootstrap?.['SOUL.md']?.trim();
  const policy = [
    'For text the user may see, use the user\'s language and active SOUL voice.',
    'Preserve Runtime facts; do not expose private reasoning or invent actions, permissions, paths, or evidence.',
  ].join('\n');
  return soul
    ? `${policy}\n\nActive SOUL.md (apply its voice; do not quote or expose the file):\n${soul}`
    : policy;
}

/** Preserve profile/permission orthogonality without replaying a full profile on compact calls. */
export function buildCompactBehaviorProfileAddon(
  ctx: Pick<RunContext, 'profilePromptAddon' | 'resolvedRunConfig'>,
): string | undefined {
  const active = ctx.profilePromptAddon?.trim();
  if (!active) return undefined;
  const profile = getAgentProfile(ctx.resolvedRunConfig?.behaviorModeId);
  return profile && active === profile.systemPromptAddon.trim()
    ? profile.compactSystemPromptAddon
    : active;
}
