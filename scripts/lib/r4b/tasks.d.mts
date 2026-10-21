export interface V2Task {
  id: string;
  version: string;
  title: string;
  ancestry: { taskId: string; relation: string; frozenTaskSuiteSha256: string };
  userInput: string;
  seed: Record<string, string>;
  allowedTools: string[];
  permissionPreset: string;
  dimensions: { goal: boolean; contract: boolean; mechanism: boolean };
  goalRules: Record<string, unknown>;
  contract: { ref: string; version: string } | null;
  faultFixture: Record<string, unknown> | null;
  oracle: { module: string; goal: string | null; contract: string | null; mechanism: string | null };
  taskDefinitionSha256?: string;
}

export interface LoadedTaskSuite {
  suite: Record<string, unknown>;
  tasks: V2Task[];
  contracts: Record<string, unknown>;
  suiteSha256: string;
  path: string;
}

export function validateTaskSuite(suite: unknown, options?: { repoRoot?: string }): { valid: boolean; errors: Array<{ code: string; path: string; message: string }> };
export function assertTaskSuite(suite: unknown, options?: { repoRoot?: string }): { valid: boolean };
export function loadTaskSuite(options?: { repoRoot?: string }): LoadedTaskSuite;
export function taskById(loaded: LoadedTaskSuite, taskId: string): V2Task;
