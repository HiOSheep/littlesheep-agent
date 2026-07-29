// Resolves one run's tool set while preserving registry ownership metadata.

import type { AgentTool, ToolRegistration } from '@littlesheep/types';

export interface ResolveRunToolsOptions {
  additionalTools?: readonly AgentTool[];
  filter?: (tool: { name: string }) => boolean;
  requireApprovalForAllTools?: boolean;
}

export interface ResolvedRunTools {
  registrations: ToolRegistration[];
  tools: AgentTool[];
  sources: Record<string, string>;
}

export function resolveRunTools(
  registered: readonly ToolRegistration[],
  options: ResolveRunToolsOptions = {},
): ResolvedRunTools {
  let registrations = [...registered];
  if (options.additionalTools && options.additionalTools.length > 0) {
    const names = new Set(registrations.map((registration) => registration.tool.name));
    for (const tool of options.additionalTools) {
      if (names.has(tool.name)) {
        throw new Error(`Additional tool name conflicts with a registered tool: ${tool.name}`);
      }
      names.add(tool.name);
      registrations.push({ tool, source: 'run-scoped' });
    }
  }
  if (options.filter) {
    registrations = registrations.filter((registration) => options.filter!(registration.tool));
  }
  if (options.requireApprovalForAllTools) {
    registrations = registrations.map((registration) => ({
      ...registration,
      tool: { ...registration.tool, requiresApproval: true },
    }));
  }
  return {
    registrations,
    tools: registrations.map((registration) => registration.tool),
    sources: Object.fromEntries(
      registrations.map((registration) => [registration.tool.name, registration.source]),
    ),
  };
}
