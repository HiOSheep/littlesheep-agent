import {
  CACHE_BOUNDARY_MARKER,
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

export interface SystemPromptAddon {
  id: string;
  text?: string;
  kind?: ContextItemKind;
  source?: ContextSourceRef;
  priority?: number;
  required?: boolean;
  scope?: ContextScope;
  /** Stable configuration belongs before the cache boundary; run facts stay after it. */
  placement?: 'stable' | 'volatile';
}

/** Append prompt additions while keeping explicitly stable policy before the cache boundary. */
export function appendSystemPromptAddons(
  systemPrompt: string,
  ...addons: Array<string | SystemPromptAddon | undefined>
): string {
  const stable: string[] = [];
  const volatile: string[] = [];
  for (const addon of addons) {
    if (!addon) continue;
    const text = typeof addon === 'string' ? addon.trim() : addon.text?.trim();
    if (!text) continue;
    (typeof addon !== 'string' && addon.placement === 'stable' ? stable : volatile).push(text);
  }
  if (stable.length === 0 && volatile.length === 0) return systemPrompt;
  let result = systemPrompt;
  if (stable.length > 0) result += `\n\n---\n\n${stable.join('\n\n---\n\n')}`;
  if (volatile.length > 0) result += `\n\n${CACHE_BOUNDARY_MARKER}\n\n${volatile.join('\n\n---\n\n')}`;
  return result;
}

/** Append source-aware prompt additions while preserving the exact outbound text. */
export function appendSystemPromptBundleAddons(
  bundle: SystemPromptBundle,
  addons: SystemPromptAddon[],
): SystemPromptBundle {
  const boundaryIndex = bundle.segments.findIndex((segment) => segment.text.includes(CACHE_BOUNDARY_MARKER));
  const stable = bundle.segments
    .slice(0, boundaryIndex < 0 ? bundle.segments.length : boundaryIndex)
    .map(stripSegmentPrefix);
  const volatile = bundle.segments
    .slice(boundaryIndex < 0 ? bundle.segments.length : boundaryIndex)
    .map(stripSegmentPrefix);
  const stableAddons: PromptContextSegment[] = [];
  const volatileAddons: PromptContextSegment[] = [];
  let stableOrder = stable.length;
  let volatileOrder = volatile.length;
  for (const addon of addons) {
    const text = addon.text?.trim();
    if (!text) continue;
    const segment: PromptContextSegment = {
      id: addon.id,
      order: addon.placement === 'stable' ? stableOrder++ : volatileOrder++,
      text,
      kind: addon.kind ?? 'system_prompt',
      source: addon.source ?? { kind: 'configuration', id: addon.id },
      priority: addon.priority ?? 95,
      required: addon.required ?? true,
      sensitive: true,
      scope: addon.scope ?? 'run',
    };
    (addon.placement === 'stable' ? stableAddons : volatileAddons).push(segment);
  }
  const segments = [...stable, ...stableAddons, ...volatile, ...volatileAddons]
    .map((segment, index) => ({ ...segment, order: index }));
  return rebuildBundle(segments, stable.length + stableAddons.length);
}

function stripSegmentPrefix(segment: PromptContextSegment): PromptContextSegment {
  return {
    ...segment,
    text: segment.text
      .replace(/^\n\n(?:---|<!-- LITTLESHEEP_CACHE_BOUNDARY -->)\n\n/u, ''),
  };
}

function rebuildBundle(segments: PromptContextSegment[], stableCount: number): SystemPromptBundle {
  const rebuilt = segments.map((segment, index) => {
    const isVolatile = index >= stableCount;
    const prefix = isVolatile
      ? (index > stableCount ? '\n\n---\n\n' : `\n\n${CACHE_BOUNDARY_MARKER}\n\n`)
      : (index > 0 ? '\n\n---\n\n' : '');
    return { ...segment, text: `${prefix}${segment.text}` };
  });
  return { text: rebuilt.map((segment) => segment.text).join(''), segments: rebuilt };
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
