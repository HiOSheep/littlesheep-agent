// @littlesheep/prompt — builder.ts
// Three-layer prompt assembly:
//   Layer 1: buildSystemPrompt — pure renderer (no config reads)
//   Layer 2: resolvePromptConfig — config-backed knobs
//   Layer 3: runtime adapter — gathers live facts, calls the facade

import type { BrandingConfig } from '@littlesheep/branding';
import type {
  AgentTool,
  ContextItemKind,
  ContextScope,
  ContextSourceRef,
} from '@littlesheep/types';
import type { MemoryPrelude } from '@littlesheep/types';
import type { Config } from '@littlesheep/config';
import { CACHE_BOUNDARY_MARKER } from './cache-boundary.js';
import { resolveRuntimeTimeZone } from './runtime-time.js';
import {
  identitySection,
  coreFlowSection,
  toolingSection,
  capabilitiesSection,
  memoryAwarenessSection,
  safetySection,
  skillsSection,
  memoryTreeSection,
  workspaceSection,
  dateTimeSection,
  runtimeSection,
  preludeSection,
  sessionSummarySection,
  outputDirectivesSection,
  responseDirectivesSection,
} from './sections.js';

/** Prompt rendering mode. */
export type PromptMode = 'full' | 'respond' | 'minimal' | 'none';

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
  sessionSummary?: import('@littlesheep/types').CompactionSummary;
  /** Bounded root index for on-demand memory-tree recall. */
  memoryRootIndex?: string;
  /** Small volatile D2 atom set selected through D1 indexes for this run. */
  initialMemoryContext?: string;
  mode?: PromptMode;
}

export interface PromptContextSegment {
  id: string;
  order: number;
  text: string;
  kind: ContextItemKind;
  source: ContextSourceRef;
  priority: number;
  required: boolean;
  sensitive: boolean;
  scope: ContextScope;
}

export interface SystemPromptBundle {
  text: string;
  segments: PromptContextSegment[];
}

/**
 * Layer 1: pure renderer. Assembles the system prompt from explicit inputs.
 * Does NOT read config. Keep this a pure function of its arguments.
 */
export function buildSystemPrompt(input: PromptInput): string {
  return buildSystemPromptBundle(input).text;
}

/** Render the same prompt with source-aware segments for Context accounting. */
export function buildSystemPromptBundle(input: PromptInput): SystemPromptBundle {
  const mode = input.mode ?? 'full';

  if (mode === 'none') {
    const text = `You are ${input.branding.displayName}.`;
    return {
      text,
      segments: [promptSegment('identity', 0, text, 'system_prompt', 100, true, 'global')],
    };
  }

  const isRespond = mode === 'respond';
  const isFull = mode === 'full';
  const stable: Array<Omit<PromptContextSegment, 'order' | 'text'> & { content: string }> = [];
  const addStable = (
    id: string,
    content: string,
    kind: ContextItemKind = 'system_prompt',
    priority = 100,
    required = true,
    scope: ContextScope = 'global',
    source: ContextSourceRef = { kind: 'prompt', id },
  ) => stable.push({ id, content, kind, source, priority, required, sensitive: true, scope });

  // ─── Canonical shared head (above cache boundary) ───
  // Every stage emits these sections in this exact order with the same bytes,
  // so a later call in the same turn reuses the prefix an earlier call already
  // prefilled. Measured effect: the cross-stage shared head grows from 293
  // bytes (identity only) to this whole sequence.
  addStable('identity', identitySection(input.branding));
  addStable('core-flow', coreFlowSection());
  addStable('safety', safetySection(), 'system_prompt', 100);
  addStable(
    'workspace',
    workspaceSection(input.workspace),
    'project_knowledge',
    95,
    // Optional: contracts that do not carry project knowledge drop this section
    // instead of rejecting the whole request, keeping the head as long as the
    // contract allows.
    false,
    'workspace',
    { kind: 'configuration', id: 'workspace', path: input.workspace },
  );
  addStable('date-time', dateTimeSection(input.timezone), 'system_prompt', 60, false);

  // ─── Stage-specific sections (still above the boundary) ───
  // The capability summary is emitted for every mode right after the head. It is
  // small and byte-identical across stages, and the faithful system-prompt
  // projection shows it extends the cross-stage shared prefix from the
  // 2593-byte head to 2921 bytes before the mode-specific tool section splits
  // the bytes (taskbook 10.116).
  addStable('capabilities', capabilitiesSection(input.tools), 'system_prompt', 98);

  if (!isRespond) {
    addStable('tooling', toolingSection(input.tools), 'system_prompt', 98);
  }

  if (isFull && input.skills && input.skills.length > 0) {
    addStable('skills-index', skillsSection(input.skills), 'system_prompt', 75, false);
  }

  if (input.runtime) {
    addStable('runtime', runtimeSection(input.runtime), 'system_prompt', 65, false);
  }

  if (isFull) {
    addStable('output-directives', outputDirectivesSection(), 'output_constraint', 95, true);
  } else if (isRespond) {
    addStable('response-directives', responseDirectivesSection(), 'output_constraint', 95, true);
  }

  const segments: PromptContextSegment[] = stable.map((section, index) => ({
    ...section,
    order: index,
    text: `${index > 0 ? '\n\n---\n\n' : ''}${section.content}`,
  }));
  let nextOrder = segments.length;
  let hasVolatile = false;
  const volatilePrefix = () => {
    const prefix = hasVolatile
      ? '\n\n---\n\n'
      : `\n\n${CACHE_BOUNDARY_MARKER}\n\n`;
    hasVolatile = true;
    return prefix;
  };

  // ─── Volatile sections (below cache boundary) ───
  if (mode !== 'minimal' && (isFull || isRespond) && input.memoryRootIndex) {
    segments.push({
      id: 'memory-root-index',
      order: nextOrder++,
      text: `${volatilePrefix()}${isRespond ? memoryAwarenessSection(input.memoryRootIndex) : memoryTreeSection(input.memoryRootIndex)}`,
      kind: 'memory_index',
      source: { kind: 'memory', id: 'root-index' },
      priority: 95,
      required: true,
      sensitive: true,
      scope: 'global',
    });
  }

  if (mode !== 'minimal' && input.sessionSummary) {
    segments.push({
      id: `summary-memory:${input.sessionSummary.id}`,
      order: nextOrder++,
      text: `${volatilePrefix()}${sessionSummarySection(input.sessionSummary)}`,
      kind: 'summary_memory',
      source: {
        kind: 'memory',
        id: input.sessionSummary.id,
        generatedAt: input.sessionSummary.compactedAt,
      },
      priority: 88,
      required: true,
      sensitive: true,
      scope: 'session',
    });
  }

  if (mode !== 'minimal' && input.initialMemoryContext) {
    segments.push({
      id: 'initial-memory-selection',
      order: nextOrder++,
      text: `${volatilePrefix()}${input.initialMemoryContext}`,
      kind: 'memory_fragment',
      source: { kind: 'memory', id: 'initial-selection' },
      priority: 92,
      required: true,
      sensitive: true,
      scope: 'run',
    });
  }

  if (mode !== 'minimal' && Object.keys(input.bootstrap).length > 0) {
    const files = Object.entries(input.bootstrap)
      .filter(([, content]) => content && content.trim().length > 0);
    files.forEach(([name, content], index) => {
      const header = index === 0
        ? '# Project Context\n\nThe following workspace files are injected for this run:\n\n'
        : '';
      const scope: ContextScope = name === 'SOUL.md' || name === 'USER.md' ? 'global' : 'workspace';
      const required = name === 'AGENTS.md';
      const priority = name === 'AGENTS.md' ? 95 : name === 'USER.md' ? 90 : name === 'SOUL.md' ? 85 : 80;
      segments.push({
        id: `bootstrap:${name}`,
        order: nextOrder++,
        text: `${volatilePrefix()}${header}## ${name}\n\n${content}`,
        kind: 'project_knowledge',
        source: { kind: 'prompt', id: name, path: name },
        priority,
        required,
        sensitive: true,
        scope,
      });
    });
  }

  if (mode !== 'minimal' && input.prelude) {
    const content = preludeSection(input.prelude);
    if (content) {
      segments.push({
        id: 'summary-memory:legacy-prelude',
        order: nextOrder++,
        text: `${volatilePrefix()}${content}`,
        kind: 'summary_memory',
        source: { kind: 'memory', id: 'legacy-prelude' },
        priority: 55,
        required: false,
        sensitive: true,
        scope: 'session',
      });
    }
  }

  return { text: segments.map((segment) => segment.text).join(''), segments };
}

function promptSegment(
  id: string,
  order: number,
  text: string,
  kind: ContextItemKind,
  priority: number,
  required: boolean,
  scope: ContextScope,
): PromptContextSegment {
  return {
    id,
    order,
    text,
    kind,
    source: { kind: 'prompt', id },
    priority,
    required,
    sensitive: true,
    scope,
  };
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
    timezone: resolveRuntimeTimeZone(d.userTimezone),
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
  sessionSummary?: import('@littlesheep/types').CompactionSummary;
  memoryRootIndex?: string;
  initialMemoryContext?: string;
  runtime?: PromptInput['runtime'];
}

export async function assembleSystemPrompt(
  resolved: ResolvedPromptConfig,
  facts: RuntimeFacts,
  mode?: PromptMode
): Promise<string> {
  return (await assembleSystemPromptBundle(resolved, facts, mode)).text;
}

export async function assembleSystemPromptBundle(
  resolved: ResolvedPromptConfig,
  facts: RuntimeFacts,
  mode?: PromptMode,
): Promise<SystemPromptBundle> {
  return buildSystemPromptBundle({
    branding: resolved.branding,
    tools: facts.tools,
    skills: facts.skills,
    workspace: resolved.workspace,
    timezone: resolved.timezone,
    runtime: facts.runtime ?? (mode === 'respond' ? undefined : {
      model: resolved.model,
      host: typeof process !== 'undefined' ? process.env.COMPUTERNAME : undefined,
      os: typeof process !== 'undefined' ? `${process.platform}/${process.arch}` : undefined,
      nodeVersion: typeof process !== 'undefined' ? process.version : undefined,
    }),
    bootstrap: facts.bootstrap,
    prelude: facts.prelude,
    sessionSummary: facts.sessionSummary,
    memoryRootIndex: facts.memoryRootIndex,
    initialMemoryContext: facts.initialMemoryContext,
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
