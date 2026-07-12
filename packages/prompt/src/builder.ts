// @littlesheep/prompt — builder.ts
// Three-layer prompt assembly:
//   Layer 1: buildSystemPrompt — pure renderer (no config reads)
//   Layer 2: resolvePromptConfig — config-backed knobs
//   Layer 3: runtime adapter — gathers live facts, calls the facade

import type { BrandingConfig } from '@littlesheep/branding';
import type { AgentTool } from '@littlesheep/types';
import type { MemoryPrelude } from '@littlesheep/types';
import type { Config } from '@littlesheep/config';
import { CACHE_BOUNDARY_MARKER } from './cache-boundary.js';
import {
  identitySection,
  coreFlowSection,
  toolingSection,
  safetySection,
  skillsSection,
  memoryTreeSection,
  workspaceSection,
  dateTimeSection,
  runtimeSection,
  projectContextSection,
  preludeSection,
  outputDirectivesSection,
} from './sections.js';

/** Prompt rendering mode. */
export type PromptMode = 'full' | 'minimal' | 'none';

/** Inputs to the pure renderer (Layer 1). */
export interface PromptInput {
  branding: BrandingConfig;
  tools: AgentTool[];
  skills?: { name: string; description: string }[];
  workspace: string;
  timezone?: string;
  runtime?: {
    model: string;
    host?: string;
    os?: string;
    nodeVersion?: string;
    repoRoot?: string;
  };
  bootstrap: Record<string, string>;
  prelude?: MemoryPrelude;
  /** Bounded root index for on-demand memory-tree recall. */
  memoryRootIndex?: string;
  mode?: PromptMode;
}

/**
 * Layer 1: pure renderer. Assembles the system prompt from explicit inputs.
 * Does NOT read config. Keep this a pure function of its arguments.
 */
export function buildSystemPrompt(input: PromptInput): string {
  const mode = input.mode ?? 'full';

  if (mode === 'none') {
    return `You are ${input.branding.displayName}.`;
  }

  const isMinimal = mode === 'minimal';
  const sections: string[] = [];

  // ─── Stable sections (above cache boundary) ───
  sections.push(identitySection(input.branding));

  if (!isMinimal) {
    sections.push(coreFlowSection());
  }

  sections.push(toolingSection(input.tools));
  sections.push(safetySection());

  if (!isMinimal && input.skills && input.skills.length > 0) {
    sections.push(skillsSection(input.skills));
  }

  if (!isMinimal && input.memoryRootIndex) {
    sections.push(memoryTreeSection(input.memoryRootIndex));
  }

  sections.push(workspaceSection(input.workspace));

  if (!isMinimal) {
    sections.push(dateTimeSection(input.timezone));
  }

  if (input.runtime) {
    sections.push(runtimeSection(input.runtime));
  }

  if (!isMinimal) {
    sections.push(outputDirectivesSection());
  }

  // ─── Cache boundary ───
  const stable = sections.join('\n\n---\n\n');
  const volatileParts: string[] = [];

  // ─── Volatile sections (below cache boundary) ───
  if (!isMinimal && Object.keys(input.bootstrap).length > 0) {
    volatileParts.push(projectContextSection(input.bootstrap));
  }

  if (!isMinimal && input.prelude) {
    volatileParts.push(preludeSection(input.prelude));
  }

  const volatile = volatileParts.join('\n\n---\n\n');
  const prompt = volatile.length > 0
    ? `${stable}\n\n${CACHE_BOUNDARY_MARKER}\n\n${volatile}`
    : stable;

  return prompt;
}

/**
 * Layer 2: resolve config-backed prompt knobs for a specific agent.
 * Reads config but does not gather live facts.
 */
export interface ResolvedPromptConfig {
  branding: BrandingConfig;
  model: string;
  workspace: string;
  timezone?: string;
  timeFormat: 'auto' | '12' | '24';
  bootstrapMaxChars: number;
  bootstrapTotalMaxChars: number;
  harness: string;
}

export function resolvePromptConfig(config: Config, branding: BrandingConfig): ResolvedPromptConfig {
  const d = config.agents.defaults;
  return {
    branding,
    model: d.model,
    workspace: d.workspace,
    timezone: d.userTimezone,
    timeFormat: d.timeFormat,
    bootstrapMaxChars: d.bootstrapMaxChars,
    bootstrapTotalMaxChars: d.bootstrapTotalMaxChars,
    harness: d.harness,
  };
}

/**
 * Layer 3: runtime adapter. Gathers live facts (tools, bootstrap file contents,
 * prelude) and calls buildSystemPrompt with a fully-resolved PromptInput.
 */
export interface RuntimeFacts {
  tools: AgentTool[];
  skills?: { name: string; description: string }[];
  bootstrap: Record<string, string>;
  prelude?: MemoryPrelude;
  memoryRootIndex?: string;
  runtime?: PromptInput['runtime'];
}

export async function assembleSystemPrompt(
  resolved: ResolvedPromptConfig,
  facts: RuntimeFacts,
  mode?: PromptMode
): Promise<string> {
  return buildSystemPrompt({
    branding: resolved.branding,
    tools: facts.tools,
    skills: facts.skills,
    workspace: resolved.workspace,
    timezone: resolved.timezone,
    runtime: facts.runtime ?? {
      model: resolved.model,
      host: typeof process !== 'undefined' ? process.env.COMPUTERNAME : undefined,
      os: typeof process !== 'undefined' ? `${process.platform}/${process.arch}` : undefined,
      nodeVersion: typeof process !== 'undefined' ? process.version : undefined,
    },
    bootstrap: facts.bootstrap,
    prelude: facts.prelude,
    memoryRootIndex: facts.memoryRootIndex,
    mode: mode ?? 'full',
  });
}

/** Truncate a bootstrap file to fit within maxChars (including the marker). */
export function truncateBootstrap(content: string, maxChars: number): { text: string; truncated: boolean } {
  if (content.length <= maxChars) return { text: content, truncated: false };
  const marker = `\n\n... [truncated: ${content.length - maxChars} chars omitted] ...\n\n`;
  // Reserve space for the marker, split the rest between head and tail.
  const budget = Math.max(20, maxChars - marker.length);
  const half = Math.floor(budget / 2);
  const head = content.slice(0, half);
  const tail = content.slice(content.length - half);
  return {
    text: `${head}${marker}${tail}`,
    truncated: true,
  };
}

/** Apply per-file + total limits to a bootstrap map. */
export function applyBootstrapLimits(
  bootstrap: Record<string, string>,
  maxPerFile: number,
  totalMax: number
): Record<string, string> {
  const result: Record<string, string> = {};
  let total = 0;
  // Skip a file if remaining budget is less than 50% of per-file max (not useful content).
  const skipThreshold = Math.floor(maxPerFile * 0.5);
  for (const [name, content] of Object.entries(bootstrap)) {
    const remaining = totalMax - total;
    if (remaining <= skipThreshold) {
      result[name] = '[skipped: bootstrap total limit reached]';
      continue;
    }
    const effectiveMax = Math.min(maxPerFile, remaining);
    const { text } = truncateBootstrap(content, effectiveMax);
    result[name] = text;
    total += text.length;
  }
  return result;
}
