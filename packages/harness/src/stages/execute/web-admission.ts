import type { AgentTool, RunContext } from '@littlesheep/types';

/** Add only requested built-in Web names to this request's execution scope. */
export function admittedNamesForToolRequests(
  ctx: Pick<RunContext, 'toolContext' | 'toolSources'>,
  tools: readonly AgentTool[],
  initiallyAdmitted: ReadonlySet<string>,
  requests: readonly { name: string }[],
  allowDynamicWeb: boolean,
): Set<string> {
  const admitted = new Set(initiallyAdmitted);
  const policy = ctx.toolContext.networkPolicy;
  if (!allowDynamicWeb || policy?.enabled !== true || policy.mode === 'disabled') return admitted;
  for (const request of requests) {
    if ((request.name === 'web_search' || request.name === 'web_fetch')
      && ctx.toolSources?.[request.name] === 'builtin'
      && tools.some((tool) => tool.name === request.name)) {
      admitted.add(request.name);
    }
  }
  return admitted;
}
