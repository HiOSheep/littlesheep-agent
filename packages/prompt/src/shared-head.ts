// Canonical, stage-independent system-prompt head.
//
// The Provider matches its prefix cache from token zero, so stages that each
// render their own system prompt never reuse one another's work: measured on
// the previous layout the shared head between the full and respond modes was
// only the identity section (293 bytes) while the prompts were 7,061 and 1,411
// bytes. This module renders the head every stage can share byte for byte, so a
// later stage in the same turn can hit what an earlier stage already prefilled.
//
// The tool section is emitted last: stages that expose different tools still
// share everything above it, and stages with the same tool set share the whole
// head.
import type { BrandingConfig } from '@littlesheep/branding';
import type { AgentTool } from '@littlesheep/types';
import {
  coreFlowSection,
  dateTimeSection,
  identitySection,
  safetySection,
  toolingSection,
  workspaceSection,
} from './sections.js';

/** Section separator used by the prompt builder for every segment after the first. */
const SECTION_SEPARATOR = '\n\n---\n\n';

export interface SharedPromptHeadInput {
  branding: BrandingConfig;
  tools: AgentTool[];
  workspace: string;
  timezone?: string;
}

export function buildSharedPromptHead(input: SharedPromptHeadInput): string {
  return [
    identitySection(input.branding),
    coreFlowSection(),
    safetySection(),
    workspaceSection(input.workspace),
    dateTimeSection(input.timezone),
    toolingSection(input.tools),
  ].join(SECTION_SEPARATOR);
}

/** Byte length of the head sections that precede the tool list. */
export function sharedPromptHeadPrefixLength(input: Omit<SharedPromptHeadInput, 'tools'>): number {
  return buildSharedPromptHead({ ...input, tools: [] }).length - toolingSection([]).length - SECTION_SEPARATOR.length;
}
